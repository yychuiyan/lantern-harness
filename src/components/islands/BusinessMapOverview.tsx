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
  onReview: () => void;
}

export default function BusinessMapOverview({ system, onFunctions, onFlows, onReview }: Props) {
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
  const showNextSteps = hasContent || tasks.length > 0;

  return (
    <div className="tw-bm-overview">
      <section className="tw-bm-overview-hero">
        <div className="tw-bm-overview-hero-copy">
          <span className="tw-bm-overview-kicker">业务全景</span>
          <h2>{system.description || '建立系统业务全景'}</h2>
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
      </section>
      <div className="tw-bm-overview-route" aria-label="业务地图维护路径">
        <button type="button" onClick={() => onFunctions()}>
          <span className="tw-bm-overview-route-node" aria-hidden="true">
            <PmIcon name="folder" size={16} />
          </span>
          <span className="tw-bm-overview-route-copy">
            <small>01 · 业务能力</small>
            <strong>
              {system.functions.length}
              <em>个功能</em>
            </strong>
            <span>{summary.domains.length} 个业务域</span>
          </span>
        </button>
        <button type="button" onClick={() => onFlows()}>
          <span className="tw-bm-overview-route-node" aria-hidden="true">
            <PmIcon name="play" size={15} />
          </span>
          <span className="tw-bm-overview-route-copy">
            <small>02 · 业务流程</small>
            <strong>
              {system.flows.length}
              <em>条流程</em>
            </strong>
            <span>{system.flows.reduce((n, flow) => n + flow.steps.length, 0)} 个业务步骤</span>
          </span>
        </button>
        <button type="button" onClick={() => onFunctions('no-evidence')}>
          <span className="tw-bm-overview-route-node" aria-hidden="true">
            <PmIcon name="file" size={15} />
          </span>
          <span className="tw-bm-overview-route-copy">
            <small>03 · 证据覆盖</small>
            <strong>
              {system.functions.length ? summary.evidencePercent : '—'}
              {system.functions.length ? <em>%</em> : null}
            </strong>
            <span>
              {summary.withEvidence} / {system.functions.length} 个功能有证据
            </span>
          </span>
        </button>
        <button type="button" onClick={() => onFunctions('unconfirmed')}>
          <span className="tw-bm-overview-route-node" aria-hidden="true">
            <PmIcon name="check" size={15} />
          </span>
          <span className="tw-bm-overview-route-copy">
            <small>04 · 人工确认</small>
            <strong>
              {summary.confirmed}
              <em>/ {system.functions.length}</em>
            </strong>
            <span>
              {summary.unconfirmed
                ? `${summary.unconfirmed} 个功能待核对`
                : system.functions.length
                  ? '功能均已确认'
                  : '等待整理第一项功能'}
            </span>
          </span>
        </button>
      </div>
      <div className={`tw-bm-overview-columns ${showNextSteps ? '' : 'is-single'}`}>
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
                <button type="button" className="tw-bm-btn" onClick={() => onFunctions()}>
                  前往功能目录
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
                <button type="button" className="tw-bm-btn" onClick={() => onFlows()}>
                  前往业务流程
                </button>
              </div>
            )}
          </section>
        </div>
        {showNextSteps ? (
          <aside className="tw-bm-overview-secondary" aria-label="地图下一步操作">
            <div className="tw-bm-overview-rail-head">
              <span>下一步</span>
              <small>
                {blockers.length
                  ? `${blockers.length} 类发布阻断`
                  : tasks.length
                    ? `${tasks.length} 类待完善`
                    : '当前检查通过'}
              </small>
            </div>
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
                      : '进入功能目录或业务流程后，这里会列出需要补充的内容。'}
                  </p>
                </div>
              )}
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
