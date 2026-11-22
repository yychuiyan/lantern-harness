import type { BusinessMapStore, BusinessProposal } from '../../lib/business-map';

const LABELS: Record<string, string> = {
  name: '名称',
  domain: '业务域',
  module: '模块',
  purpose: '作用',
  roles: '角色',
  entry: '入口',
  inputs: '输入',
  outputs: '输出',
  rules: '规则',
  writes: '落库口径',
  exceptions: '异常',
  implementation: '实现',
  steps: '流程步骤',
  result: '最终结果',
};
const SOURCE_LABELS: Record<string, string> = {
  page: '页面观察',
  doc: '文档要求',
  code: '实现线索',
  manual: '人工依据',
};
function display(value: unknown) {
  return value == null || value === ''
    ? '未填写'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
}
export default function BusinessMapProposalDetails({
  proposal,
  system,
}: {
  proposal: BusinessProposal;
  system: BusinessMapStore['systems'][number];
}) {
  const target = (proposal.targetType === 'function' ? system.functions : system.flows).find(
    (item) => item.id === proposal.targetId,
  );
  const before = target as unknown as Record<string, unknown> | undefined;
  const changes = Object.entries(proposal.payload).filter(
    ([key, value]) => LABELS[key] && JSON.stringify(before?.[key]) !== JSON.stringify(value),
  );
  return (
    <div className="tw-bm-proposal-details" onClick={(event) => event.stopPropagation()}>
      {changes.length ? (
        <details>
          <summary>
            {proposal.action === 'add' ? '候选内容' : '字段变更'} · {changes.length} 项
          </summary>
          <dl>
            {changes.map(([key, value]) => (
              <div key={key}>
                <dt>{LABELS[key]}</dt>
                {target ? <dd className="before">原值：{display(before?.[key])}</dd> : null}
                <dd>建议：{display(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {proposal.evidence.length ? (
        <details>
          <summary>来源证据 · {proposal.evidence.length} 条</summary>
          {proposal.evidence.map((ref, index) => (
            <section key={`${ref.id}-${index}`}>
              <strong>
                {SOURCE_LABELS[ref.type]} · {ref.title}
              </strong>
              <code>{ref.ref || '未记录位置'}</code>
              {ref.note ? <blockquote>{ref.note}</blockquote> : <p>该历史证据未记录原文片段。</p>}
            </section>
          ))}
        </details>
      ) : null}
      {proposal.action === 'update' && proposal.targetType === 'function' ? (
        <p>人工锁定字段保留原值，AI 建议不会覆盖。</p>
      ) : null}
    </div>
  );
}
