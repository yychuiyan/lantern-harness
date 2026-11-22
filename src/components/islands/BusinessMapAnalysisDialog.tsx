import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from '@headlessui/react';
import type { BusinessSystem } from '../../lib/business-map';
import { loadSettings } from '../../lib/settings';
import {
  ANALYSIS_STATUS,
  analysisRunning,
  commandBusinessAnalysis,
  listAnalysisDocuments,
  listBusinessAnalyses,
  startBusinessAnalysis,
  type AnalysisDocument,
  type AnalysisJob,
  type AnalysisMode,
} from '../../lib/business-map-analysis';
import { showToast } from './Toast';
import SelectDropdown from './SelectDropdown';

interface Props {
  system: BusinessSystem;
  revision: number;
  initialFunctionId?: string;
  closing?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onReview: () => void;
}
const split = (value: string) =>
  value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
export default function BusinessMapAnalysisDialog({
  system,
  revision,
  initialFunctionId,
  closing,
  onClose,
  onChanged,
  onReview,
}: Props) {
  const [mode, setMode] = useState<AnalysisMode>(initialFunctionId ? 'single' : 'system');
  const [selected, setSelected] = useState<string[]>(initialFunctionId ? [initialFunctionId] : []);
  const [names, setNames] = useState('');
  const [sources, setSources] = useState({
    page: !!system.entryUrl,
    doc: false,
    code: !!system.sourceDir,
  });
  const [documents, setDocuments] = useState<AnalysisDocument[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [entryUrl, setEntryUrl] = useState(system.entryUrl);
  const [sourceDir, setSourceDir] = useState(system.sourceDir);
  const [pageUrls, setPageUrls] = useState('');
  const [runtimeDir, setRuntimeDir] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [maxPages, setMaxPages] = useState(100);
  const [maxDepth, setMaxDepth] = useState(5);
  const [timeoutMinutes, setTimeoutMinutes] = useState(30);
  const [autoDraft, setAutoDraft] = useState(true);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [selectedJob, setSelectedJob] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [tab, setTab] = useState<'configure' | 'jobs'>('configure');
  const seen = useRef(new Map<string, string>());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const refresh = useCallback(async () => {
    const result = await listBusinessAnalyses(system.id);
    setJobs(result.jobs);
    let changed = false;
    for (const job of result.jobs) {
      const before = seen.current.get(job.id);
      if (before !== job.status && !analysisRunning(job)) changed = true;
      seen.current.set(job.id, job.status);
    }
    if (changed) onChangedRef.current();
    return result.jobs;
  }, [system.id]);
  useEffect(() => {
    let alive = true;
    void listAnalysisDocuments()
      .then((result) => {
        if (alive) setDocuments(result.documents);
      })
      .catch((error) => {
        if (alive) setCatalogError(error.message);
      });
    void refresh()
      .then((jobs) => {
        if (alive && jobs.length && !initialFunctionId) {
          setSelectedJob(jobs[0].id);
          setTab('jobs');
        }
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    const timer = window.setInterval(() => {
      if (alive) void refresh().catch((error) => setError(error.message));
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [refresh, initialFunctionId]);
  const job = jobs.find((item) => item.id === selectedJob) || jobs[0];
  const running = jobs.some(analysisRunning);
  const existingTargets = selected.map((functionId) => ({ functionId }));
  const newNames = [...new Set(split(names))].filter(
    (name) => !system.functions.some((fn) => selected.includes(fn.id) && fn.name === name),
  );
  const targets = [...existingTargets, ...newNames.map((name) => ({ name }))];
  async function start() {
    setError('');
    const settings = loadSettings();
    if (!settings) {
      setError('请先在模型设置中配置可用模型');
      return;
    }
    if (mode === 'single' && targets.length !== 1) {
      setError('请选择或输入 1 个功能');
      return;
    }
    if (mode === 'multiple' && targets.length < 2) {
      setError('请至少选择或输入 2 个不同功能');
      return;
    }
    if (!Object.values(sources).some(Boolean)) {
      setError('至少选择一个取证来源');
      return;
    }
    if (sources.doc && !documentIds.length) {
      setError('请选择当前系统的关联文档');
      return;
    }
    setBusy(true);
    try {
      const result = await startBusinessAnalysis(
        system.id,
        revision,
        {
          scope: { mode, targets },
          sources: {
            page: { enabled: sources.page },
            doc: { enabled: sources.doc },
            code: { enabled: sources.code },
          },
          documents: documentIds,
          entryUrl,
          sourceDir,
          pageUrls: split(pageUrls),
          exclusions: split(exclusions),
          runtimeDir,
          maxPages,
          maxDepth,
          timeoutMinutes,
          autoDraft,
        },
        settings,
      );
      setSelectedJob(result.job.id);
      setJobs((items) => [result.job, ...items.filter((item) => item.id !== result.job.id)]);
      seen.current.set(result.job.id, 'running');
      setTab('jobs');
      showToast('识别已在后台启动，可离开页面');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      onChangedRef.current();
    } finally {
      setBusy(false);
    }
  }
  async function command(action: 'cancel' | 'retry' | 'rollback') {
    if (!job) return;
    setBusy(true);
    setError('');
    try {
      const settings = loadSettings();
      if (action === 'retry' && !settings) throw new Error('请先配置模型');
      const result = await commandBusinessAnalysis(
        system.id,
        job.id,
        action,
        settings || undefined,
      );
      setJobs((items) => items.map((item) => (item.id === result.job.id ? result.job : item)));
      if (action === 'retry') seen.current.set(job.id, 'running');
      onChangedRef.current();
      if (action === 'rollback')
        showToast(
          `已撤回 ${result.job.result.rollback?.removed.length || 0} 项；已编辑或关联流程的内容保留`,
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (items: string[], value: string) =>
    items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  return (
    <Dialog open onClose={onClose} className="tw-bm-theme relative z-110">
      <DialogBackdrop className={`tw-bm-overlay ${closing ? 'is-closing' : ''}`} />
      <DialogPanel
        as="aside"
        className={`tw-bm-sheet tw-bm-analysis-sheet ${closing ? 'is-closing' : ''}`}
      >
        <header className="tw-bm-sheet-head">
          <div className="tw-bm-sheet-top">
            <span className="tw-bm-badge accent">AI 自动识别</span>
            <span className="spacer" />
            <button className="tw-bm-icon-btn" type="button" aria-label="关闭" onClick={onClose}>
              ×
            </button>
          </div>
          <DialogTitle as="h2">{system.name}</DialogTitle>
          <DialogDescription>
            只读采集页面、文档和源码，自动整理功能，保留人工确认内容。
          </DialogDescription>
          <div className="tw-bm-analysis-tabs">
            <button
              type="button"
              className={tab === 'configure' ? 'active' : ''}
              onClick={() => setTab('configure')}
            >
              识别设置
            </button>
            <button
              type="button"
              className={tab === 'jobs' ? 'active' : ''}
              onClick={() => setTab('jobs')}
            >
              后台任务 {jobs.length || ''}
            </button>
          </div>
        </header>
        <div className="tw-bm-sheet-body">
          {error ? (
            <p className="tw-bm-field-error" role="alert">
              {error}
            </p>
          ) : null}
          {tab === 'configure' ? (
            <div className="tw-bm-form">
              <fieldset className="tw-bm-analysis-range">
                <legend>识别范围</legend>
                {(
                  [
                    { value: 'single', label: '指定功能' },
                    { value: 'multiple', label: '多个功能' },
                    { value: 'system', label: '系统全量' },
                  ] as const
                ).map((item) => (
                  <label key={item.value}>
                    <input
                      type="radio"
                      name="analysisMode"
                      value={item.value}
                      checked={mode === item.value}
                      onChange={() => {
                        setMode(item.value);
                        if (item.value === 'single') setSelected((items) => items.slice(0, 1));
                      }}
                    />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              {mode !== 'system' ? (
                <section>
                  <h3>选择已有功能，或输入待发现功能</h3>
                  <div className="tw-bm-analysis-options">
                    {system.functions.map((fn) => (
                      <label key={fn.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(fn.id)}
                          onChange={() =>
                            setSelected((items) =>
                              mode === 'single'
                                ? items.includes(fn.id)
                                  ? []
                                  : [fn.id]
                                : toggle(items, fn.id),
                            )
                          }
                        />
                        {fn.code} · {fn.name}
                      </label>
                    ))}
                  </div>
                  <label>
                    <span>待发现功能名称或业务描述（一行一个）</span>
                    <textarea
                      name="analysisTargets"
                      rows={3}
                      value={names}
                      onChange={(e) => setNames(e.target.value)}
                      placeholder="例如：费用报销审批"
                    />
                  </label>
                </section>
              ) : (
                <div className="tw-bm-form-note">
                  全量范围代表当前账号与所选资料可覆盖的业务。任务会列出失败、跳过和达到限制的项目。
                </div>
              )}
              <fieldset className="tw-bm-analysis-range">
                <legend>取证来源</legend>
                {(
                  [
                    { value: 'page', label: '系统页面' },
                    { value: 'doc', label: '需求文档' },
                    { value: 'code', label: '源码目录' },
                  ] as const
                ).map((item) => (
                  <label key={item.value}>
                    <input
                      type="checkbox"
                      checked={sources[item.value]}
                      onChange={(e) => setSources({ ...sources, [item.value]: e.target.checked })}
                    />
                    {item.label}
                  </label>
                ))}
              </fieldset>
              {sources.page ? (
                <>
                  <label>
                    <span>系统入口（使用系统设置中的登录态）</span>
                    <input
                      name="analysisEntryUrl"
                      value={entryUrl}
                      onChange={(e) => setEntryUrl(e.target.value)}
                      placeholder="https://..."
                    />
                  </label>
                  <label>
                    <span>指定页面入口（一行一个，可选）</span>
                    <textarea
                      rows={2}
                      value={pageUrls}
                      onChange={(e) => setPageUrls(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
              {sources.doc ? (
                <section>
                  <h3>关联文档</h3>
                  {catalogError ? <p className="tw-bm-field-error">{catalogError}</p> : null}
                  <div className="tw-bm-analysis-options">
                    {documents.map((doc) => (
                      <label key={doc.id}>
                        <input
                          type="checkbox"
                          disabled={!doc.supported}
                          checked={documentIds.includes(doc.id)}
                          onChange={() => setDocumentIds((items) => toggle(items, doc.id))}
                        />
                        <span>
                          {doc.id}
                          {!doc.supported ? '（暂不支持）' : ''}
                        </span>
                      </label>
                    ))}
                    {!documents.length ? (
                      <p>文档库暂无可选择资料，不会默认读取其他系统文档。</p>
                    ) : null}
                  </div>
                </section>
              ) : null}
              {sources.code ? (
                <label>
                  <span>本地源码目录</span>
                  <input
                    name="analysisSourceDir"
                    value={sourceDir}
                    onChange={(e) => setSourceDir(e.target.value)}
                  />
                </label>
              ) : null}
              <details>
                <summary>采集限制与排除范围</summary>
                <div className="tw-bm-form">
                  <label>
                    <span>最多采集页面数（1–300）</span>
                    <input
                      type="number"
                      min={1}
                      max={300}
                      value={maxPages}
                      onChange={(e) => setMaxPages(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    <span>最大探索深度（0–8）</span>
                    <input
                      type="number"
                      min={0}
                      max={8}
                      value={maxDepth}
                      onChange={(e) => setMaxDepth(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    <span>任务时间上限（分钟，1–60）</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={timeoutMinutes}
                      onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    <span>排除源码路径（一行一个，相对于源码目录）</span>
                    <textarea
                      rows={2}
                      value={exclusions}
                      onChange={(e) => setExclusions(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>浏览器运行时所在目录（已安装 Playwright 的项目，可选）</span>
                    <input value={runtimeDir} onChange={(e) => setRuntimeDir(e.target.value)} />
                  </label>
                  <p className="tw-bm-form-note">
                    来源正文最多 200 万字符。POST 等写请求和危险入口会被拦截，依赖 POST
                    查询的页面可能仅部分可见。
                  </p>
                </div>
              </details>
              <label className="tw-bm-analysis-check">
                <input
                  type="checkbox"
                  checked={autoDraft}
                  onChange={(e) => setAutoDraft(e.target.checked)}
                />
                <span>有两类一致证据的低风险新功能自动进入草稿</span>
              </label>
              <p className="tw-bm-form-note">
                其他结果进入待审核；不会自动删除、覆盖人工字段或发布。模型使用当前设置，采集内容将发送给所选模型服务。
              </p>
              <a className="tw-bm-text-action" href="/plugins/?tab=skills">
                配置业务地图识别技能
              </a>
            </div>
          ) : (
            <>
              {jobs.length ? (
                <>
                  <label className="tw-bm-form">
                    <span>识别任务</span>
                    <SelectDropdown
                      ariaLabel="识别任务"
                      triggerHintZIndex={210}
                      value={job?.id || ''}
                      onChange={setSelectedJob}
                      options={jobs.map((item) => ({
                        value: item.id,
                        label: `${new Date(item.createdAt).toLocaleString()} · ${ANALYSIS_STATUS[item.status]}`,
                      }))}
                      showCheck
                      className="tw-bm-field-select"
                    />
                  </label>
                  {job ? (
                    <div className="tw-bm-analysis-result">
                      <span className={`tw-bm-badge ${job.status === 'succeeded' ? 'ok' : 'warn'}`}>
                        {ANALYSIS_STATUS[job.status]}
                      </span>
                      <h3>{job.message}</h3>
                      {job.skill ? <p>本次技能版本：v{job.skill.version}</p> : null}
                      <p>
                        实际采集：{job.coverage.pages} 个页面 · {job.coverage.documents} 份文档 ·{' '}
                        {job.coverage.codeFiles} 个源码文件
                      </p>
                      <p>
                        证据分析：{job.progress.batches || 0} / {job.progress.totalBatches || 0} 批
                        · 模型用量 {job.usage.totalTokens} tokens
                      </p>
                      <p>
                        自动入草稿 {job.result.autoApplied.length} 项 · 待审核 {job.result.pending}{' '}
                        项 · 已存在 {job.result.duplicates} 项
                      </p>
                      {job.issues.length ? (
                        <details open>
                          <summary>{job.issues.length} 项采集或校验说明</summary>
                          <ul>
                            {job.issues.map((issue, index) => (
                              <li key={index}>{issue}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {job.result.rollback ? (
                        <p>
                          已撤回 {job.result.rollback.removed.length} 项，保留{' '}
                          {job.result.rollback.skipped.length} 项已修改内容。
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="tw-bm-overview-empty">
                  <strong>还没有识别任务</strong>
                  <p>选择范围与资料后开始，任务可在后台继续。</p>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="tw-bm-sheet-foot">
          <button className="tw-bm-btn" type="button" onClick={onClose}>
            关闭
          </button>
          <span className="spacer" />
          {tab === 'configure' ? (
            <button
              className="tw-bm-btn primary"
              type="button"
              disabled={busy || running}
              onClick={() => void start()}
            >
              {running ? '当前系统正在识别' : '开始后台识别'}
            </button>
          ) : job ? (
            <>
              {analysisRunning(job) ? (
                <button
                  className="tw-bm-btn danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void command('cancel')}
                >
                  取消任务
                </button>
              ) : (
                <>
                  <button
                    className="tw-bm-btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void command('retry')}
                  >
                    从检查点重试
                  </button>
                  {job.result.autoApplied.length && !job.result.rollback ? (
                    <button
                      className="tw-bm-btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void command('rollback')}
                    >
                      撤回本批新增
                    </button>
                  ) : null}
                </>
              )}
              <button className="tw-bm-btn primary" type="button" onClick={onReview}>
                审核提案
              </button>
            </>
          ) : (
            <button className="tw-bm-btn primary" type="button" onClick={() => setTab('configure')}>
              配置识别
            </button>
          )}
        </footer>
      </DialogPanel>
    </Dialog>
  );
}
