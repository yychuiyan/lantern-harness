import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  listBusinessMaterials,
  listBusinessAnalyses,
  startBusinessAnalysis,
  uploadBusinessMaterial,
  type AnalysisDocument,
  type AnalysisJob,
  type AnalysisMaterial,
  type AnalysisMode,
} from '../../lib/business-map-analysis';
import { showToast } from './Toast';
import SelectDropdown from './SelectDropdown';
import MultiSelectDropdown from './MultiSelectDropdown';
import BusinessMapLoginSettings from './BusinessMapLoginSettings';
import OverflowHint from './OverflowHint';

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
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
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
    onlineDoc: false,
    process: system.flows.length > 0,
    doc: false,
    material: false,
    code: !!system.sourceDir,
  });
  const [documents, setDocuments] = useState<AnalysisDocument[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [materials, setMaterials] = useState<AnalysisMaterial[]>([]);
  const [materialNames, setMaterialNames] = useState<string[]>([]);
  const [materialsError, setMaterialsError] = useState('');
  const [uploadingMaterials, setUploadingMaterials] = useState(false);
  const [entryUrl, setEntryUrl] = useState(system.entryUrl);
  const [sourceDir, setSourceDir] = useState(system.sourceDir);
  const [pageUrls, setPageUrls] = useState('');
  const [onlineDocUrls, setOnlineDocUrls] = useState('');
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
    void listBusinessMaterials(system.id)
      .then((result) => {
        if (alive) setMaterials(result.materials);
      })
      .catch((error) => {
        if (alive) setMaterialsError(error.message);
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
  }, [refresh, initialFunctionId, system.id]);
  const job = jobs.find((item) => item.id === selectedJob) || jobs[0];
  const running = jobs.some(analysisRunning);
  const functionOptions = useMemo(
    () =>
      system.functions.map((fn) => ({
        value: fn.id,
        label: fn.code ? `${fn.code} · ${fn.name}` : fn.name,
      })),
    [system.functions],
  );
  const existingTargets = selected.map((functionId) => ({ functionId }));
  const pendingNames = [...new Set(split(names))].filter(
    (name) => !system.functions.some((fn) => selected.includes(fn.id) && fn.name === name),
  );
  const targets = [...existingTargets, ...pendingNames.map((name) => ({ name }))];
  const targetCount = targets.length;
  const singleTargetConflict = mode === 'single' && targetCount > 1;
  function setSingleFunction(functionId: string) {
    setSelected(functionId ? [functionId] : []);
    if (functionId) setNames('');
  }
  function updatePendingNames(value: string) {
    setNames(value);
    if (mode === 'single' && value.trim()) setSelected([]);
  }
  function removePendingName(name: string) {
    setNames(pendingNames.filter((item) => item !== name).join('\n'));
  }
  async function uploadMaterials(files: File[]) {
    if (!files.length) return;
    setMaterialsError('');
    setUploadingMaterials(true);
    const uploaded: string[] = [];
    try {
      for (const file of files) {
        const item = await uploadBusinessMaterial(system.id, file);
        uploaded.push(item.name);
      }
      const result = await listBusinessMaterials(system.id);
      setMaterials(result.materials);
      setMaterialNames((current) => [...new Set([...current, ...uploaded])]);
      if (uploaded.length) showToast(`已上传 ${uploaded.length} 份本地资料`, 'success');
    } catch (error) {
      setMaterialsError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadingMaterials(false);
    }
  }
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
    if (sources.onlineDoc && !split(onlineDocUrls).length) {
      setError('请至少填写一个在线文档链接');
      return;
    }
    if (sources.material && !materialNames.length) {
      setError('请至少选择一份本地资料');
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
            onlineDoc: { enabled: sources.onlineDoc },
            process: { enabled: sources.process },
            doc: { enabled: sources.doc },
            material: { enabled: sources.material },
            code: { enabled: sources.code },
          },
          documents: documentIds,
          onlineDocUrls: split(onlineDocUrls),
          materials: materialNames,
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
          'success',
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
            只读采集系统页面、在线文档、需求文档、业务流程、本地资料与源码，自动整理功能并保留人工确认内容。
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
                <section className="tw-bm-analysis-targets">
                  <div className="tw-bm-analysis-target-heading">
                    <div>
                      <h3>识别目标</h3>
                      <p>选择已有功能，或填写待发现功能；任务会按目标整理结果。</p>
                    </div>
                    <span className="tw-bm-target-count">{targetCount} 个目标</span>
                  </div>
                  <div className="tw-bm-analysis-target-card">
                    <div className="tw-bm-analysis-target-card-head">
                      <span>已有功能</span>
                      <small>{mode === 'single' ? '单选' : '可多选'}</small>
                    </div>
                    {system.functions.length ? (
                      mode === 'single' ? (
                        <SelectDropdown
                          ariaLabel="选择已有功能"
                          value={selected[0] || ''}
                          onChange={setSingleFunction}
                          options={[
                            { value: '', label: '选择已有功能（可选）', muted: true },
                            ...functionOptions,
                          ]}
                          searchable
                          searchPlaceholder="搜索功能名称或编号…"
                          className="tw-bm-target-select"
                        />
                      ) : (
                        <MultiSelectDropdown
                          options={functionOptions}
                          values={selected}
                          onChange={setSelected}
                          placeholder="搜索并选择已有功能"
                          chips
                          chipsMaxHeight={120}
                          searchable
                          searchPlaceholder="搜索功能名称或编号…"
                          triggerClassName="tw-bm-target-select"
                        />
                      )
                    ) : (
                      <p className="tw-bm-target-empty">
                        当前系统还没有已确认功能，可以直接填写待发现功能。
                      </p>
                    )}
                  </div>
                  <div className="tw-bm-analysis-target-card">
                    <label>
                      <span>
                        待发现功能名称或业务描述
                        <small>一行一个</small>
                      </span>
                      <textarea
                        name="analysisTargets"
                        rows={3}
                        value={names}
                        onChange={(e) => updatePendingNames(e.target.value)}
                        placeholder="例如：费用报销审批&#10;库存查询与导出"
                      />
                    </label>
                    {pendingNames.length ? (
                      <div className="tw-bm-target-chips" aria-label="待发现功能">
                        {pendingNames.map((name) => (
                          <span className="tw-bm-target-chip" key={name}>
                            <OverflowHint text={name} className="tw-bm-target-chip-text" />
                            <button
                              type="button"
                              aria-label={`移除待发现功能 ${name}`}
                              onClick={() => removePendingName(name)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="tw-bm-target-hint">
                        AI 会把每一行作为一个待发现目标；已有功能请在上方选择。
                      </p>
                    )}
                  </div>
                  {singleTargetConflict ? (
                    <p className="tw-bm-field-error" role="alert">
                      指定功能模式只能处理 1 个目标，请清空已有功能或待发现功能。
                    </p>
                  ) : null}
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
                    { value: 'onlineDoc', label: '在线文档' },
                    { value: 'process', label: '业务流程' },
                    { value: 'doc', label: '需求文档' },
                    { value: 'material', label: '本地资料' },
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
                    <span>系统入口（复用已保存的登录态）</span>
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
              {sources.onlineDoc ? (
                <label>
                  <span>在线文档链接（一行一个）</span>
                  <textarea
                    rows={3}
                    value={onlineDocUrls}
                    onChange={(e) => setOnlineDocUrls(e.target.value)}
                    placeholder="https://docs.qq.com/...&#10;https://..."
                  />
                  <small className="tw-bm-form-note">
                    仅读取链接页面正文；需要登录的文档会复用当前系统登录态，仍无法读取时会列入任务说明。
                  </small>
                </label>
              ) : null}
              {sources.process ? (
                <div className="tw-bm-form-note">
                  当前业务流程中的 {system.flows.length} 条流程和{' '}
                  {system.flows.reduce((n, flow) => n + flow.steps.length, 0)}{' '}
                  个步骤会作为业务上下文参与识别；没有流程时不会产生空白证据。
                </div>
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
              {sources.material ? (
                <section>
                  <h3>本地业务资料</h3>
                  <div className="tw-bm-material-upload-row">
                    <label className="tw-bm-btn tw-bm-material-upload">
                      <input
                        type="file"
                        multiple
                        disabled={uploadingMaterials}
                        onChange={(event) => {
                          const files = [...(event.target.files || [])];
                          event.target.value = '';
                          void uploadMaterials(files);
                        }}
                      />
                      {uploadingMaterials ? '上传中…' : '上传本地资料'}
                    </label>
                    <span>支持 Markdown、Word、Excel、XMind、PPTX 等资料，单个文件最大 25MB。</span>
                  </div>
                  {materialsError ? <p className="tw-bm-field-error">{materialsError}</p> : null}
                  <div className="tw-bm-analysis-options tw-bm-material-list">
                    {materials.map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          disabled={!item.supported}
                          checked={materialNames.includes(item.name)}
                          onChange={() => setMaterialNames((items) => toggle(items, item.name))}
                        />
                        <OverflowHint text={item.name} className="tw-bm-material-name" />
                        <small>{formatBytes(item.size)}</small>
                        {!item.supported ? <em>暂不支持解析</em> : null}
                      </label>
                    ))}
                    {!materials.length ? <p>尚未上传本地资料。上传后可勾选参与本次识别。</p> : null}
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
              {sources.page ? (
                <details>
                  <summary>系统登录配置</summary>
                  <BusinessMapLoginSettings systemId={system.id} />
                </details>
              ) : null}
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
              <p className="tw-bm-form-note">
                关联技能处于停用状态也不会阻断业务地图识别，本次继续使用当前已保存的识别规则。
              </p>
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
                      {job.status === 'awaiting_input' ? (
                        <BusinessMapLoginSettings systemId={system.id} />
                      ) : null}
                      {job.skill ? <p>本次技能版本：v{job.skill.version}</p> : null}
                      <p>
                        实际采集：{job.coverage.pages} 个页面 · {job.coverage.onlineDocs || 0}{' '}
                        份在线文档 · {job.coverage.documents} 份需求文档 ·{' '}
                        {job.coverage.materials || 0} 份本地资料 · {job.coverage.processes || 0}{' '}
                        条业务流程 · {job.coverage.codeFiles} 个源码文件
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
