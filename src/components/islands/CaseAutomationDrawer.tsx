import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  applyCaseAutomation,
  assessCaseAutomation,
  fetchCaseAutomationIterations,
  getCaseAutomationSource,
  getCaseAutomationSelection,
  type CaseAutomationAssessment,
  type CaseAutomationAssessmentItem,
  type CaseAutomationIterationInfo,
} from '../../lib/case-automation';
import type { CaseExecutionDocument } from '../../lib/case-execution';
import { fetchProjects, type UiAutoProject } from '../../lib/ui-auto';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

const DECISION_LABEL = {
  automatable: '可自动生成',
  needs_manual: '需人工补充',
  not_automatable: '不可 UI 自动化',
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
  not_automatable: 'border-stone-200 bg-stone-50 text-stone-500',
  connected: 'border-blue-200 bg-blue-50 text-blue-700',
  running: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  passed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  partial: 'border-orange-200 bg-orange-50 text-orange-700',
  stale: 'border-amber-200 bg-amber-50 text-amber-700',
  not_applicable: 'border-stone-200 bg-stone-50 text-stone-400',
};

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
  const [document, setDocument] = useState<CaseExecutionDocument | null>(null);
  const [projects, setProjects] = useState<UiAutoProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [iterationInfo, setIterationInfo] = useState<CaseAutomationIterationInfo | null>(null);
  const [iteration, setIteration] = useState('');
  const [creatingIteration, setCreatingIteration] = useState(false);
  const [rememberedIteration, setRememberedIteration] = useState('');
  const [newIteration, setNewIteration] = useState('');
  const [selectedCases, setSelectedCases] = useState<Record<string, boolean>>({});
  const [assessment, setAssessment] = useState<CaseAutomationAssessment | null>(null);
  const [selectedAssessments, setSelectedAssessments] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const supportedProjects = useMemo(
    () =>
      projects.filter(
        (project) => project.kind === 'ui' && project.framework === 'playwright' && project.exists,
      ),
    [projects],
  );

  const load = useCallback(async () => {
    if (!casePath) return;
    setBusy(true);
    setError('');
    setAssessment(null);
    setSelectedAssessments({});
    try {
      const [file, projectData, selection] = await Promise.all([
        getCaseAutomationSource(casePath),
        fetchProjects(),
        getCaseAutomationSelection(casePath),
      ]);
      setDocument(file);
      setProjects(projectData.projects || []);
      setRememberedIteration(selection?.iteration || '');
      if (selection?.projectId) setProjectId(selection.projectId);
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

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || !projectId) {
      setIterationInfo(null);
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

  const sourceCases = document?.cases || [];
  const selectedSourceIds = sourceCases
    .filter((item) => selectedCases[item.id])
    .map((item) => item.id);
  const unassessedCount = sourceCases.filter(
    (item) => (item.automation?.status || 'not_configured') === 'not_configured',
  ).length;
  const assessmentCounts = useMemo(
    () => ({
      automatable: assessment?.cases.filter((item) => item.decision === 'automatable').length || 0,
      needs_manual:
        assessment?.cases.filter((item) => item.decision === 'needs_manual').length || 0,
      not_automatable:
        assessment?.cases.filter((item) => item.decision === 'not_automatable').length || 0,
    }),
    [assessment],
  );

  async function assess() {
    if (!projectId || !iteration || !selectedSourceIds.length) return;
    setBusy(true);
    setError('');
    setAssessment(null);
    try {
      const data = await assessCaseAutomation({
        casePath,
        caseIds: selectedSourceIds,
        projectId,
        iteration,
      });
      setAssessment(data.assessment);
      setSelectedAssessments(
        Object.fromEntries(
          data.assessment.cases
            .filter((item) => item.decision !== 'not_automatable')
            .map((item) => [item.sourceCaseId, true]),
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!assessment) return;
    const ids = Object.keys(selectedAssessments).filter((id) => selectedAssessments[id]);
    if (!ids.length) {
      setError('请至少选择一条有效转换结果');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await applyCaseAutomation({
        assessmentId: assessment.id,
        selectedSourceCaseIds: ids,
      });
      showToast(`已生成 ${result.links?.length ?? 0} 条自动化用例`, 'success');
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title="自动化识别评估"
      widthClass="max-w-3xl"
      bodyClassName="flex flex-col gap-4 overflow-hidden"
      footer={
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-stone-100 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <span className="text-xs text-stone-500">
            {assessment
              ? `可生成 ${assessmentCounts.automatable} · 需人工 ${assessmentCounts.needs_manual} · 不可自动化 ${assessmentCounts.not_automatable}`
              : `已选 ${selectedSourceIds.length} / ${sourceCases.length} 条 · 未评估 ${unassessedCount} 条`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="h-9 rounded-lg border border-stone-200 px-3 text-sm text-stone-600"
            >
              关闭
            </button>
            {assessment ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void apply()}
                className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? '正在生成…' : '生成自动化用例'}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !projectId || !iteration || selectedSourceIds.length === 0}
                onClick={() => void assess()}
                className="h-9 rounded-lg bg-[#4176e6] px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? '识别评估中…' : '开始识别评估'}
              </button>
            )}
          </div>
        </div>
      }
    >
      <section className="grid shrink-0 gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-medium text-stone-600">UI 自动化项目</span>
          <SelectDropdown
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              setIteration('');
              setCreatingIteration(false);
              setAssessment(null);
            }}
            options={supportedProjects.map((project) => ({
              value: project.id,
              label: project.name,
              secondary: `${project.frameworkLabel} · ${project.baseURL || project.detectedBaseURL || '未配置地址'}`,
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
              setAssessment(null);
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
        <div className="shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {!assessment ? (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-stone-800">评估范围</h3>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                默认全选当前文件中的用例，可取消不需要识别的条目；已评估状态会保留。
              </p>
            </div>
            <span className="shrink-0 text-xs text-stone-400">{sourceCases.length} 条</span>
          </div>
          <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {sourceCases.map((item) => (
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
                    {(() => {
                      const status = item.automation?.status || 'not_configured';
                      return (
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
                            SOURCE_STATUS_TONE[status] || SOURCE_STATUS_TONE.not_configured
                          }`}
                        >
                          {SOURCE_STATUS_LABEL[status] || status}
                        </span>
                      );
                    })()}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-5 text-stone-500">
                    {item.steps || item.expected || '缺少步骤与预期'}
                  </span>
                </span>
              </label>
            ))}
            {!sourceCases.length ? (
              <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
                当前文件没有可评估用例
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <AssessmentPreview
            assessment={assessment}
            selected={selectedAssessments}
            onToggle={(id) =>
              setSelectedAssessments((current) => ({ ...current, [id]: !current[id] }))
            }
          />
        </div>
      )}
    </SlideOverDrawer>
  );
}

function AssessmentPreview({
  assessment,
  selected,
  onToggle,
}: {
  assessment: CaseAutomationAssessment;
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="rounded-lg bg-[#f5f8ff] px-3 py-2 text-xs text-stone-600">
        目标项目：{assessment.projectName} · 迭代 {assessment.iteration} ·{' '}
        {assessment.iterationFile}
      </div>
      {assessment.cases.map((item) => (
        <AssessmentCard
          key={item.sourceCaseId}
          item={item}
          checked={Boolean(selected[item.sourceCaseId])}
          onToggle={() => onToggle(item.sourceCaseId)}
        />
      ))}
    </section>
  );
}

function AssessmentCard({
  item,
  checked,
  onToggle,
}: {
  item: CaseAutomationAssessmentItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <article className="rounded-lg border border-stone-200 p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={item.decision === 'not_automatable'}
          onChange={onToggle}
          className="mt-1"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-stone-800">{item.sourceTitle}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] ${DECISION_TONE[item.decision]}`}
            >
              {DECISION_LABEL[item.decision]}
            </span>
          </span>
          <span className="mt-1 block text-xs leading-5 text-stone-500">{item.reason}</span>
        </span>
      </label>
      {item.automationCases.length ? (
        <div className="mt-3 space-y-2">
          {item.automationCases.map((automationCase) => (
            <div key={automationCase.automationCaseId} className="rounded-md bg-stone-50 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-stone-700">{automationCase.title}</span>
                <span className="text-[10px] text-stone-400">{automationCase.priority}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-stone-500">
                {automationCase.steps.join(' → ')}
              </p>
              <p className="mt-1 text-[11px] text-emerald-700">{automationCase.expected}</p>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
