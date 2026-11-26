import { useEffect, useState } from 'react';
import { type BusinessSystem } from '../../lib/business-map';
import {
  readBusinessMapSystemSort,
  writeBusinessMapSystemSort,
} from '../../lib/business-map-memory';
import {
  businessCreatedLabel,
  businessSystemSummary,
  filterBusinessSystems,
  type BusinessSystemSort,
} from '../../lib/business-map-view';
import { PmIcon } from './PmShared';
import SelectDropdown from './SelectDropdown';

interface Props {
  systems: BusinessSystem[];
  query: string;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onSettings: (id: string) => void;
  onCopy: (id: string) => void;
  onCreate: () => void;
  onDemo: () => void;
  busy: boolean;
}

export default function BusinessMapSystems({
  systems,
  query,
  onQuery,
  onSelect,
  onSettings,
  onCopy,
  onCreate,
  onDemo,
  busy,
}: Props) {
  const [sort, setSort] = useState<BusinessSystemSort>(readBusinessMapSystemSort);
  useEffect(() => writeBusinessMapSystemSort(sort), [sort]);
  const visible = filterBusinessSystems(systems, 'all', query, sort);
  const totalFunctions = systems.reduce((n, system) => n + system.functions.length, 0);
  const totalFlows = systems.reduce((n, system) => n + system.flows.length, 0);
  return (
    <div className="tw-bm-portfolio">
      <header className="tw-bm-portfolio-head tw-pm-page-header">
        <span className="tw-pm-page-ico" aria-hidden="true">
          <PmIcon name="folder" size={18} />
        </span>
        <div>
          <h1 className="tw-page-title">业务地图</h1>
          <p className="tw-page-desc">从系统到功能与流程，让业务结构有迹可循。</p>
        </div>
      </header>
      <div className="tw-bm-portfolio-tools">
        <div className="tw-bm-portfolio-meta">
          <span>{systems.length} 个业务系统</span>
          <span>{totalFunctions} 个功能</span>
          <span>{totalFlows} 条业务流程</span>
          {visible.length !== systems.length ? <span>筛选出 {visible.length} 个</span> : null}
        </div>
        <div className="tw-bm-portfolio-actions">
          <label className="tw-bm-portfolio-search">
            <PmIcon name="search" size={14} />
            <input
              name="systemSearch"
              autoComplete="off"
              aria-label="搜索业务系统"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索系统、业务域或功能…"
            />
            {query ? (
              <button type="button" onClick={() => onQuery('')} aria-label="清空系统搜索">
                ×
              </button>
            ) : null}
          </label>
          <SelectDropdown
            compact
            ariaLabel="系统排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'created', label: '创建时间（旧→新）' },
              { value: 'name', label: '系统名称' },
            ]}
            className="tw-bm-portfolio-sort"
          />

          <button type="button" className="tw-bm-btn primary" onClick={onCreate}>
            <PmIcon name="plus" size={15} />
            新建系统
          </button>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        找到 {visible.length} 个系统
      </span>
      {visible.length ? (
        <div className="tw-bm-portfolio-grid">
          {visible.map((system) => {
            const summary = businessSystemSummary(system);
            return (
              <article className="tw-bm-portfolio-card-shell" key={system.id}>
                <button
                  type="button"
                  className="tw-bm-portfolio-card"
                  onClick={() => onSelect(system.id)}
                  aria-label={`查看 ${system.name} 的业务地图`}
                >
                  <span className="tw-bm-portfolio-card-head">
                    <span className="tw-bm-system-card-avatar" aria-hidden="true">
                      {system.name.trim()[0] || '?'}
                    </span>
                    <span className="tw-bm-portfolio-card-title">
                      <strong>{system.name}</strong>
                      <small title={system.entryUrl}>{system.entryUrl || '尚未配置系统入口'}</small>
                    </span>
                  </span>
                  <span className="tw-bm-portfolio-card-desc">
                    {system.description || '补充系统说明，明确业务范围与使用场景。'}
                  </span>
                  <span className="tw-bm-portfolio-card-stats">
                    <span>
                      <strong>{system.functions.length}</strong>功能
                    </span>
                    <span>
                      <strong>{system.flows.length}</strong>流程
                    </span>
                    <span>
                      <strong>
                        {system.functions.length ? `${summary.evidencePercent}%` : '—'}
                      </strong>
                      证据覆盖
                    </span>
                  </span>
                  <span className="tw-bm-portfolio-domains">
                    {summary.domains.length ? (
                      summary.domains.slice(0, 3).map((domain) => (
                        <span key={domain.name}>
                          {domain.name}
                          <small>{domain.functions.length}</small>
                        </span>
                      ))
                    ) : (
                      <span className="is-empty">尚未整理功能目录</span>
                    )}
                    {summary.domains.length > 3 ? <span>+{summary.domains.length - 3}</span> : null}
                  </span>
                </button>
                <div className="tw-bm-portfolio-card-foot">
                  <span>{businessCreatedLabel(system.createdAt)}</span>
                  <span className="tw-bm-portfolio-card-actions">
                    <button
                      type="button"
                      className="tw-bm-portfolio-card-settings"
                      aria-label={`复制系统配置：${system.name}`}
                      disabled={busy}
                      onClick={() => onCopy(system.id)}
                    >
                      <PmIcon name="copy" size={14} />
                      复制
                    </button>
                    <button
                      type="button"
                      className="tw-bm-portfolio-card-settings"
                      aria-label={`系统设置：${system.name}`}
                      disabled={busy}
                      onClick={() => onSettings(system.id)}
                    >
                      <PmIcon name="sliders" size={14} />
                      系统设置
                    </button>
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="tw-bm-portfolio-empty">
          <span className="tw-pm-page-ico" aria-hidden="true">
            <PmIcon name="folder" size={24} />
          </span>
          <h2>{systems.length ? '没有匹配的业务系统' : '建立第一张业务地图'}</h2>
          <p>
            {systems.length
              ? '换个关键词，或重置筛选条件。'
              : '先创建业务系统，再整理功能、业务流程和证据。也可以先用示例了解维护方式。'}
          </p>
          <div className="tw-bm-empty-actions">
            {systems.length ? (
              <button
                type="button"
                className="tw-bm-btn"
                onClick={() => {
                  onQuery('');
                }}
              >
                重置筛选
              </button>
            ) : (
              <>
                <button type="button" className="tw-bm-btn primary" onClick={onCreate}>
                  新建系统
                </button>
                <button type="button" className="tw-bm-btn" disabled={busy} onClick={onDemo}>
                  查看示例地图
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
