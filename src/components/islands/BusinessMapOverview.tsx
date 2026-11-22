import { localPublishCheck, type BusinessSystem } from '../../lib/business-map';
import {
  businessEntryUrl,
  businessSystemSummary,
  businessUpdatedLabel,
  type BusinessFunctionFilter,
} from '../../lib/business-map-view';
import { PmIcon } from './PmShared';

interface Props {
  system: BusinessSystem;
  onFunctions: (filter?: BusinessFunctionFilter, domain?: string) => void;
  onFlows: (id?: string) => void;
  onNewFunction: () => void;
  onNewFlow: () => void;
  onReview: () => void;
  onPublish: () => void;
  onAnalyze: () => void;
}

export default function BusinessMapOverview({
  system,
  onFunctions,
  onFlows,
  onNewFunction,
  onNewFlow,
  onReview,
  onPublish,
  onAnalyze,
}: Props) {
  const summary = businessSystemSummary(system);
  const check = localPublishCheck(system);
  const blockers = check.items.filter((item) => item.level === 'block');
  const entry = businessEntryUrl(system.entryUrl);
  const hasContent = system.functions.length > 0 || system.flows.length > 0;
  const tasks: Array<{ label: string; description: string; count: number; onClick: () => void }> = [
    {
      label: '提案待审核',
      description: '确认后应用到业务草稿',
      count: summary.pending,
      onClick: onReview,
    },
    {
      label: '功能待确认',
      description: '核对业务口径与使用方式',
      count: summary.unconfirmed,
      onClick: () => onFunctions('unconfirmed'),
    },
    {
      label: '功能缺少证据',
      description: '补充页面、文档或源码依据',
      count: summary.noEvidence,
      onClick: () => onFunctions('no-evidence'),
    },
    {
      label: '功能未关联流程',
      description: '检查它参与的业务过程',
      count: summary.unlinked,
      onClick: () => onFunctions('unlinked'),
    },
  ].filter((task) => task.count > 0);

  return (
    <div className="tw-bm-overview">
      <section className="tw-bm-overview-intro">
        <div>
          <h2>系统概览</h2>
          <p>{system.description || '为系统补充业务说明，帮助团队了解它服务的业务范围。'}</p>
          <div className="tw-bm-overview-meta">
            {entry ? (
              <a href={entry} target="_blank" rel="noopener noreferrer">
                <PmIcon name="folder" size={13} />
                访问业务系统<span aria-hidden="true">↗</span>
              </a>
            ) : (
              <span>尚未配置系统入口</span>
            )}
            <span>{businessUpdatedLabel(system.updatedAt)}</span>
            {system.id === 'demo_work_order' ? <span className="tw-bm-badge">示例系统</span> : null}
          </div>
        </div>
        <button type="button" className="tw-bm-btn primary" onClick={onNewFunction}>
          <PmIcon name="plus" size={14} />
          新建功能
        </button>
      </section>
      <div className="tw-bm-overview-metrics" aria-label="地图维护概况">
        <button type="button" onClick={() => onFunctions()}>
          <span>
            业务功能
            <PmIcon name="chevronRight" size={13} />
          </span>
          <strong>
            {system.functions.length}
            <small>个</small>
          </strong>
          <em>{summary.domains.length} 个业务域</em>
        </button>
        <button type="button" onClick={() => onFlows()}>
          <span>
            业务流程
            <PmIcon name="chevronRight" size={13} />
          </span>
          <strong>
            {system.flows.length}
            <small>条</small>
          </strong>
          <em>{system.flows.reduce((n, flow) => n + flow.steps.length, 0)} 个业务步骤</em>
        </button>
        <button type="button" onClick={() => onFunctions('no-evidence')}>
          <span>
            证据覆盖
            <PmIcon name="chevronRight" size={13} />
          </span>
          <strong>
            {system.functions.length ? summary.evidencePercent : '—'}
            {system.functions.length ? <small>%</small> : null}
          </strong>
          <em>
            {summary.withEvidence} / {system.functions.length} 个功能有证据
          </em>
        </button>
        <button type="button" onClick={() => onFunctions('unconfirmed')}>
          <span>
            人工确认
            <PmIcon name="chevronRight" size={13} />
          </span>
          <strong>
            {summary.confirmed}
            <small>/ {system.functions.length}</small>
          </strong>
          <em>
            {summary.unconfirmed
              ? `${summary.unconfirmed} 个功能待核对`
              : system.functions.length
                ? '功能均已确认'
                : '等待整理第一项功能'}
          </em>
        </button>
      </div>
      <div className="tw-bm-overview-columns">
        <div className="tw-bm-overview-primary">
          <section className="tw-bm-overview-section">
            <header>
              <div>
                <h3>业务结构</h3>
                <p>按业务域组织功能，找到每项能力的归属。</p>
              </div>
              <button type="button" className="tw-bm-text-action" onClick={() => onFunctions()}>
                功能目录
                <PmIcon name="chevronRight" size={14} />
              </button>
            </header>
            {summary.domains.length ? (
              <div className="tw-bm-domain-map">
                {summary.domains.map((domain) => (
                  <button
                    type="button"
                    key={domain.name}
                    onClick={() => onFunctions('all', domain.name)}
                    className="tw-bm-domain-row"
                  >
                    <span className="tw-bm-domain-node" aria-hidden="true">
                      <PmIcon name="folder" size={17} />
                    </span>
                    <span className="tw-bm-domain-description">
                      <strong>{domain.name}</strong>
                      <small>
                        {domain.functions
                          .slice(0, 3)
                          .map((item) => item.name)
                          .join(' · ')}
                        {domain.functions.length > 3 ? '…' : ''}
                      </small>
                    </span>
                    <span className="tw-bm-domain-coverage">
                      <span>{domain.functions.length} 个功能</span>
                      <span className="tw-bm-domain-bar" aria-hidden="true">
                        <i
                          style={{
                            width: `${(domain.functions.length / system.functions.length) * 100}%`,
                          }}
                        />
                      </span>
                    </span>
                    <PmIcon name="chevronRight" size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="tw-bm-overview-empty">
                <PmIcon name="folder" size={24} />
                <strong>从一项业务功能开始</strong>
                <p>说明它解决的问题、使用角色和输入输出，业务域会自动汇集到这里。</p>
                <button type="button" className="tw-bm-btn" onClick={onNewFunction}>
                  新建第一个功能
                </button>
              </div>
            )}
          </section>
          <section className="tw-bm-overview-section">
            <header>
              <div>
                <h3>业务流程</h3>
                <p>串起功能，了解业务从哪里开始、如何结束。</p>
              </div>
              <button type="button" className="tw-bm-text-action" onClick={onNewFlow}>
                <PmIcon name="plus" size={14} />
                新建流程
              </button>
            </header>
            {system.flows.length ? (
              <div className="tw-bm-flow-previews">
                {system.flows.slice(0, 4).map((flow) => (
                  <button
                    type="button"
                    key={flow.id}
                    className="tw-bm-flow-preview"
                    onClick={() => onFlows(flow.id)}
                  >
                    <span className="tw-bm-flow-preview-code">{flow.code}</span>
                    <span className="tw-bm-flow-preview-content">
                      <strong>{flow.name}</strong>
                      <span>{flow.result || '尚未填写最终业务结果'}</span>
                      <small>
                        {flow.steps.length
                          ? flow.steps
                              .slice(0, 3)
                              .map((step) => step.title)
                              .join(' → ') + (flow.steps.length > 3 ? ' → …' : '')
                          : '还没有步骤，点击开始维护'}
                      </small>
                    </span>
                    <span className="tw-bm-flow-preview-count">
                      {flow.steps.length} 步<PmIcon name="chevronRight" size={14} />
                    </span>
                  </button>
                ))}
                {system.flows.length > 4 ? (
                  <button type="button" className="tw-bm-overview-all" onClick={() => onFlows()}>
                    查看全部 {system.flows.length} 条流程
                    <PmIcon name="chevronRight" size={14} />
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="tw-bm-overview-empty compact">
                <strong>还没有业务流程</strong>
                <p>选一个真实业务场景，按触发、办理和结束状态整理步骤。</p>
                <button type="button" className="tw-bm-btn" onClick={onNewFlow}>
                  新建第一条流程
                </button>
              </div>
            )}
          </section>
        </div>
        <aside className="tw-bm-overview-secondary" aria-label="地图维护提醒">
          <section className="tw-bm-overview-section">
            <header>
              <div>
                <h3>{hasContent ? '待完善' : '开始整理'}</h3>
                <p>从具体缺口继续完善地图。</p>
              </div>
              {tasks.length ? (
                <span className="tw-bm-badge warn">{tasks.length} 类事项</span>
              ) : null}
            </header>
            {tasks.length ? (
              <div className="tw-bm-quality-tasks">
                {tasks.map((task) => (
                  <button type="button" key={task.label} onClick={task.onClick}>
                    <span>
                      <strong>{task.label}</strong>
                      <small>{task.description}</small>
                    </span>
                    <b>{task.count}</b>
                    <PmIcon name="chevronRight" size={13} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="tw-bm-quality-clear">
                <PmIcon name="check" size={20} />
                <strong>{hasContent ? '暂无功能维护提醒' : '先描绘业务，再逐步补证据'}</strong>
                <p>
                  {hasContent
                    ? '发布前仍需检查流程连接与承载功能。'
                    : '新建功能与流程后，这里会列出需要补充的内容。'}
                </p>
              </div>
            )}
          </section>
          <section className="tw-bm-overview-section tw-bm-publish-summary">
            <header>
              <div>
                <h3>发布检查</h3>
                <p>
                  {system.status === 'published' ? '当前地图已发布' : '当前内容保存在待发布草稿中'}
                </p>
              </div>
            </header>
            <div className="tw-bm-publish-summary-body">
              <span className={`tw-bm-badge ${blockers.length ? 'warn' : 'ok'}`}>
                {blockers.length ? `${blockers.length} 类阻断项` : '无发布阻断项'}
              </span>
              <p>
                {blockers.length ? blockers[0].title : '查看完整检查结果，确认后发布当前地图。'}
              </p>
              <button type="button" className="tw-bm-btn" onClick={onPublish}>
                查看发布检查
                <PmIcon name="chevronRight" size={14} />
              </button>
            </div>
          </section>
          <div className="tw-bm-analysis-note">
            <PmIcon name="file" size={16} />
            <div>
              <strong>AI 自动识别</strong>
              <p>
                按指定功能、多个功能或系统全量采集页面、关联文档和源码。低风险新增可自动入草稿，其他结果由人工审核。
              </p>
              <button type="button" className="tw-bm-text-action" onClick={onAnalyze}>
                开始自动识别
                <PmIcon name="chevronRight" size={13} />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
