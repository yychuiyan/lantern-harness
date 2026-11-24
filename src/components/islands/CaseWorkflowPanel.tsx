import { useCallback, useEffect, useState } from 'react';
import type { CaseExecutionDocument } from '../../lib/case-execution';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import ConfirmDialog from './ConfirmDialog';
import OverflowHint from './OverflowHint';

interface Plan {
  id: string;
  status: string;
  error?: string;
  note?: string;
  engine: string;
  environment: { name: string; role: string; build: string; dataNote: string };
  items: {
    caseId: string;
    title: string;
    status: string;
    runId: string;
    externalRunId?: string;
    finalStatus?: string;
  }[];
  taskRuns?: { label: string; runId: string; status: string }[];
  cleanupWarning?: string;
  externalResult?: {
    status: string;
    reportUrl?: string;
    logUrl?: string;
    total?: number;
    passed?: number;
    failed?: number;
    error?: string;
  };
}
interface Acceptance {
  total: number;
  passed: number;
  pending: number;
  failed: number;
  blocked: number;
  skipped: number;
  acceptance: { ready: boolean; reasons: string[] };
  designCoverage: Record<
    string,
    { total: number; covered: number; rate: number | null; missing: string[] }
  >;
  provenance: { tracked: boolean; stale: boolean };
  note: string;
  environments?: { key: string; label: string }[];
  progressCoverage?: Record<string, { total: number; executed: number; passed: number }>;
}
interface Project {
  id: string;
  name?: string;
  title?: string;
  framework: string;
  specFiles?: string[];
}
async function request(route: string, value?: unknown) {
  const response = await fetch(
    route,
    value === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        },
  );
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
const inputClass =
  'h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-700 outline-none focus:border-[var(--tw-accent)] disabled:opacity-50';
const labels: Record<string, string> = {
  draft: '未启动',
  running: '执行中',
  stopped: '已停止',
  interrupted: '已中断',
  blocked: '阻塞',
  awaiting_confirmation: '等待人工验证',
  verified: '已人工验证',
  completed: '已完成验证',
  pending: '未执行',
};

export default function CaseWorkflowPanel({
  open,
  onClose,
  document,
  url,
  storageStatePath,
  onRefresh,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  document: CaseExecutionDocument;
  url: string;
  storageStatePath: string;
  onRefresh: () => Promise<void>;
  onRun: (id: string) => void;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [report, setReport] = useState<Acceptance | null>(null);
  const [reportEnvironment, setReportEnvironment] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [environment, setEnvironment] = useState({ name: '', role: '', build: '', dataNote: '' });
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [engine, setEngine] = useState('browser');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [specFile, setSpecFile] = useState('');
  const [taskId, setTaskId] = useState('full');
  const [setupTaskId, setSetupTaskId] = useState('');
  const [cleanupTaskId, setCleanupTaskId] = useState('');
  const [analyses, setAnalyses] = useState<{ id: string; title: string }[]>([]);
  const [analysisId, setAnalysisId] = useState('');
  const [verificationDrafts, setVerificationDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    apply: () => Promise<void>;
  } | null>(null);
  const load = useCallback(async () => {
    const [history, summary] = await Promise.all([
      request('/__tb_case_run/plans?path=' + encodeURIComponent(document.path)),
      request(
        '/__tb_case_design/acceptance?casePath=' +
          encodeURIComponent(document.path) +
          '&environmentKey=' +
          encodeURIComponent(reportEnvironment),
      ),
    ]);
    setPlans(history.plans || []);
    setReport(summary);
  }, [document.path, reportEnvironment]);
  useEffect(() => {
    if (!open) return;
    void load().catch((reason) => setError(reason.message));
    void request('/__tb_uiauto/projects')
      .then((data) => setProjects(data.projects || []))
      .catch(() => setProjects([]));
    void request('/__tb_reqanalysis/list')
      .then((data) => setAnalyses(data.docs || []))
      .catch(() => setAnalyses([]));
    const timer = window.setInterval(
      () => void load().catch((reason) => setError(reason.message)),
      1500,
    );
    return () => window.clearInterval(timer);
  }, [open, load]);
  useEffect(() => {
    setSelected([]);
    setReport(null);
    setReportEnvironment('');
  }, [document.path]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function createPlan() {
    await request('/__tb_case_run/plans', {
      casePath: document.path,
      expectedFileHash: document.fileHash,
      caseIds: selected,
      engine,
      url,
      storageStatePath,
      environment,
      allowedOrigins: allowedOrigins
        .split(/[\n,，]/)
        .map((value) => value.trim())
        .filter(Boolean),
      projectId,
      file: specFile,
      taskId,
      setupTaskId,
      cleanupTaskId,
    });
    setSelected([]);
  }
  async function prepareColumns() {
    const result = await request('/__tb_case_run/prepare-columns', {
      casePath: document.path,
      mode: 'preview',
    });
    setConfirm({
      title: '补齐执行列',
      message: `将为「${document.path}」补充 ${result.preview.missingColumns.join('、')}，写入前自动备份，已有单元格保持原样。`,
      apply: async () => {
        await request('/__tb_case_run/prepare-columns', {
          casePath: document.path,
          mode: 'apply',
          expectedFileHash: result.preview.fileHash,
        });
        await onRefresh();
      },
    });
  }
  async function linkBaseline() {
    const result = await request('/__tb_case_design/link', {
      casePath: document.path,
      analysisId,
      mode: 'preview',
    });
    setConfirm({
      title: '关联当前需求基线',
      message: `「${document.path}」的 ${result.preview.affected.length} 条用例将关联此需求版本。历史执行记录保留，结果需人工重新核验后计入通过。`,
      apply: async () => {
        await request('/__tb_case_design/link', {
          casePath: document.path,
          analysisId,
          mode: 'apply',
          expectedFileHash: result.preview.fileHash,
          expectedRevision: result.preview.revision,
        });
        await onRefresh();
      },
    });
  }
  function downloadReport() {
    if (!report) return;
    const text = [
      `# 用例验收：${document.path}`,
      `生成时间：${new Date().toLocaleString()}`,
      `结论：${report.acceptance.ready ? '满足当前文件验收条件' : '尚不满足验收条件'}`,
      `总数 ${report.total}，通过 ${report.passed}，待验证 ${report.pending}，不通过 ${report.failed}，阻塞 ${report.blocked}，跳过 ${report.skipped}`,
      ...Object.entries(report.designCoverage).map(
        ([kind, value]) =>
          `${kind} 覆盖：${value.covered}/${value.total}；未覆盖：${value.missing.join('、') || '无'}`,
      ),
      ...report.acceptance.reasons.map((reason) => '- ' + reason),
      report.note,
    ].join('\n\n');
    const href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = window.document.createElement('a');
    a.href = href;
    a.download = '用例验收报告.md';
    a.click();
    URL.revokeObjectURL(href);
  }
  return (
    <>
      <SlideOverDrawer
        open={open}
        onClose={onClose}
        title="执行计划与验收"
        widthClass="max-w-3xl"
        escDisabled={!!confirm}
        bodyClassName="space-y-6"
      >
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">当前文件验收</h3>
            <button
              type="button"
              onClick={downloadReport}
              disabled={!report}
              className="tw-btn tw-btn-ghost text-xs"
            >
              导出报告
            </button>
          </div>
          {report?.environments?.length ? (
            <SelectDropdown
              ariaLabel="验收环境和构建"
              value={reportEnvironment}
              onChange={setReportEnvironment}
              options={[
                { value: '', label: '当前文件结果（选择环境可隔离验收）' },
                ...report.environments.map((item) => ({ value: item.key, label: item.label })),
              ]}
            />
          ) : null}
          {report ? (
            <>
              <p className="text-sm">
                {report.acceptance.ready ? '满足当前文件验收条件' : '尚不满足验收条件'} · 通过{' '}
                {report.passed}/{report.total} · 待验证 {report.pending}
              </p>
              <div className="flex flex-wrap gap-4 text-xs text-stone-500">
                {Object.entries(report.designCoverage).map(([kind, item]) => (
                  <span key={kind}>
                    {kind} 覆盖 {item.covered}/{item.total}
                    {item.rate === null ? '（未定义）' : ` · ${item.rate}%`}
                  </span>
                ))}
              </div>
              {report.progressCoverage ? (
                <div className="flex flex-wrap gap-3 text-xs text-stone-500">
                  {Object.entries(report.progressCoverage).map(([kind, item]) => (
                    <span key={kind}>
                      {kind} 执行覆盖 {item.executed}/{item.total} · 通过覆盖 {item.passed}/
                      {item.total}
                    </span>
                  ))}
                </div>
              ) : null}
              <ul className="list-inside list-disc text-xs text-amber-700">
                {report.acceptance.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-stone-500">正在读取覆盖与人工结果…</p>
          )}
          <p className="text-xs text-stone-500">
            报告按需求基线与人工最终判定汇总，不代表缺陷已关闭或性能验证完成。
          </p>
          {!document.executable && document.ext !== '.xls' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(prepareColumns)}
              className="tw-btn tw-btn-ghost text-xs"
            >
              预览并补齐执行列
            </button>
          ) : null}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SelectDropdown
                value={analysisId}
                options={analyses.map((item) => ({ value: item.id, label: item.title }))}
                onChange={setAnalysisId}
                ariaLabel="选择需求分析以关联基线"
              />
            </div>
            <button
              type="button"
              disabled={!analysisId || busy}
              onClick={() => void act(linkBaseline)}
              className="tw-btn tw-btn-ghost text-xs"
            >
              关联 / 更新基线
            </button>
          </div>
        </section>
        <section className="space-y-3 border-t border-stone-200 pt-4">
          <h3 className="text-sm font-semibold">新建执行计划</h3>
          <p className="text-xs text-stone-500">
            只运行明确勾选的用例；完成后逐条人工验证结果。准备、清理数据请使用现有自动化项目任务，测试数据说明会保留在环境快照中。
          </p>
          <SelectDropdown
            value={engine}
            onChange={setEngine}
            options={[
              { value: 'browser', label: 'AI 浏览器单条串行执行' },
              { value: 'automation', label: '现有自动化项目（接口 / App / UI）' },
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            {(['name', 'role', 'build', 'dataNote'] as const).map((key) => (
              <label key={key} className={key === 'dataNote' ? 'col-span-2' : ''}>
                <span className="mb-1 block text-xs text-stone-500">
                  {
                    {
                      name: '环境名称',
                      role: '测试角色',
                      build: '被测构建版本',
                      dataNote: '测试数据、准备与清理说明',
                    }[key]
                  }
                </span>
                <input
                  value={environment[key]}
                  onChange={(event) =>
                    setEnvironment({ ...environment, [key]: event.target.value })
                  }
                  className={inputClass}
                />
              </label>
            ))}
          </div>
          {engine === 'browser' ? (
            <>
              <p className="text-xs text-stone-500">
                目标地址沿用执行配置：{url || '尚未填写'}
                ；登录态沿用当前配置。公开页面也可不提供登录态。
              </p>
              <label className="block text-xs text-stone-500">
                额外允许的登录站点（完整 origin，逗号分隔）
                <input
                  value={allowedOrigins}
                  onChange={(event) => setAllowedOrigins(event.target.value)}
                  placeholder="https://login.example.com"
                  className={inputClass}
                />
              </label>
            </>
          ) : (
            <>
              <SelectDropdown
                value={projectId}
                onChange={(value) => {
                  setProjectId(value);
                  setSpecFile('');
                }}
                options={projects.map((project) => ({
                  value: project.id,
                  label: `${project.name || project.title || project.id} · ${project.framework}`,
                }))}
                ariaLabel="选择已挂载的自动化项目"
              />
              {!projects.length ? (
                <p className="text-xs text-amber-700">
                  暂无自动化项目，请先在自动化测试页面挂载项目并准备运行环境。
                </p>
              ) : null}
              <label className="block text-xs text-stone-500">
                指定测试文件（必填，避免误运行整个项目）
                <input
                  value={specFile}
                  onChange={(event) => setSpecFile(event.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block text-xs text-stone-500">
                运行任务 ID（默认 full；可填写项目已配置的准备 / 清理任务）
                <input
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                  className={inputClass}
                />
              </label>
            </>
          )}
          {engine === 'automation' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-stone-500">
                准备任务 ID（可选）
                <input
                  value={setupTaskId}
                  onChange={(event) => setSetupTaskId(event.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-stone-500">
                清理任务 ID（可选）
                <input
                  value={cleanupTaskId}
                  onChange={(event) => setCleanupTaskId(event.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
          ) : null}
          <div className="max-h-60 overflow-y-auto rounded-lg border border-stone-200">
            {document.cases.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 border-b border-stone-100 px-3 py-2 text-xs last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
                <OverflowHint text={item.title} className="min-w-0 truncate" />
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={
              busy ||
              !selected.length ||
              !environment.name.trim() ||
              !environment.build.trim() ||
              (engine === 'browser' ? !url.trim() : !projectId || !specFile.trim())
            }
            onClick={() => void act(createPlan)}
            className="tw-btn tw-btn-primary"
          >
            创建计划（{selected.length} 条）
          </button>
        </section>
        <section className="space-y-3 border-t border-stone-200 pt-4">
          <h3 className="text-sm font-semibold">计划与运行记录</h3>
          {plans.length ? (
            plans.map((plan) => (
              <div key={plan.id} className="space-y-2 rounded-lg border border-stone-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {plan.environment.name || '未命名环境'} · {plan.environment.build} ·{' '}
                    {labels[plan.status] || plan.status}
                  </span>
                  <div className="flex gap-2">
                    {['draft', 'interrupted', 'stopped', 'blocked'].includes(plan.status) ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/__tb_case_run/plans/${plan.id}/start`, {});
                          })
                        }
                        className="text-xs text-[var(--tw-accent)]"
                      >
                        {plan.status === 'draft' ? '启动' : '继续未完成项'}
                      </button>
                    ) : null}
                    {plan.status === 'running' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await request(`/__tb_case_run/plans/${plan.id}/stop`, {});
                          })
                        }
                        className="text-xs text-red-600"
                      >
                        停止计划
                      </button>
                    ) : null}
                  </div>
                </div>
                {plan.error ? <p className="text-xs text-red-600">{plan.error}</p> : null}
                {plan.note ? <p className="text-xs text-amber-700">{plan.note}</p> : null}
                {plan.externalResult ? (
                  <p className="text-xs">
                    自动化项目：{plan.externalResult.status} · 通过{' '}
                    {plan.externalResult.passed || 0}/{plan.externalResult.total || 0}{' '}
                    {plan.externalResult.reportUrl ? (
                      <a
                        href={plan.externalResult.reportUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--tw-accent)]"
                      >
                        打开报告
                      </a>
                    ) : null}
                    {plan.externalResult.error}
                  </p>
                ) : null}
                {plan.taskRuns?.map((task) => (
                  <p key={task.runId} className="text-xs text-stone-500">
                    {task.label} · {task.status}{' '}
                    <a
                      href={'/__tb_uiauto/run?id=' + encodeURIComponent(task.runId)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--tw-accent)]"
                    >
                      查看运行记录
                    </a>
                  </p>
                ))}
                {plan.cleanupWarning ? (
                  <p className="text-xs text-amber-700">{plan.cleanupWarning}</p>
                ) : null}
                {plan.items.map((item) => (
                  <div key={item.caseId} className="flex items-center gap-2 text-xs">
                    <OverflowHint text={item.title} className="min-w-0 flex-1 truncate" />
                    <span>{labels[item.status] || item.status}</span>
                    {plan.status !== 'running' && (item.runId || item.externalRunId) ? (
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`人工实际结果：${item.title}`}
                          value={verificationDrafts[plan.id + ':' + item.caseId] || ''}
                          onChange={(event) =>
                            setVerificationDrafts({
                              ...verificationDrafts,
                              [plan.id + ':' + item.caseId]: event.target.value,
                            })
                          }
                          placeholder="填写核验后的实际结果，再选择状态"
                          className={inputClass}
                        />
                        <div className="w-32 shrink-0">
                          <SelectDropdown
                            ariaLabel={`计划最终结果：${item.title}`}
                            value={item.finalStatus || '待验证'}
                            disabled={
                              busy || !verificationDrafts[plan.id + ':' + item.caseId]?.trim()
                            }
                            options={['待验证', '通过', '不通过', '阻塞', '跳过'].map((value) => ({
                              value,
                              label: value,
                            }))}
                            onChange={(status) =>
                              void act(async () => {
                                const latest = await request(
                                  '/__tb_case_run/cases?path=' + encodeURIComponent(document.path),
                                );
                                await request(`/__tb_case_run/plans/${plan.id}/result`, {
                                  caseId: item.caseId,
                                  status,
                                  actualResult: verificationDrafts[plan.id + ':' + item.caseId],
                                  expectedFileHash: latest.document.fileHash,
                                });
                                await onRefresh();
                              })
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                    {item.runId ? (
                      <button
                        type="button"
                        onClick={() => {
                          onRun(item.runId);
                          onClose();
                        }}
                        className="text-[var(--tw-accent)]"
                      >
                        查看证据
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ))
          ) : (
            <p className="text-xs text-stone-500">尚无计划。先选择环境与用例范围，再创建并启动。</p>
          )}
        </section>
      </SlideOverDrawer>
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message || ''}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm?.apply;
          setConfirm(null);
          if (action) void act(action);
        }}
      />
    </>
  );
}
