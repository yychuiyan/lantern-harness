/**
 * 需求分析：单条用户故事的卡片（七段式展示 + 可编辑）。
 *
 * - 展示：角色 / 前置 / 主流程 / 替代流程 / 异常 / 后置 / 验收，加来源条目与维度；
 * - 编辑：结构化行编辑（不是一整块 JSON），保存时整条回传，由服务端做白名单校验；
 * - 缺口标记：这条故事在体检里被点名时，卡片上直接标出来。
 */
import { useState } from 'react';

import { PmIcon, PmTag } from './PmShared';
import SelectDropdown, { type SelectOption } from './SelectDropdown';
import {
  GAP_SEVERITY_TONE,
  REQ_PRIORITY_TONE,
  GAP_SEVERITY_LABEL,
  GAP_TYPE_LABEL,
  type ReqGap,
  type ReqStory,
} from '../../lib/req-analysis';

const PRIORITY_OPTIONS: SelectOption<ReqStory['priority']>[] = [
  { value: 'P0', label: 'P0 · 必须做' },
  { value: 'P1', label: 'P1 · 应该做' },
  { value: 'P2', label: 'P2 · 可以做' },
];

const INPUT =
  'h-9 w-full rounded-md border border-stone-200 bg-white px-2 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff] placeholder:text-stone-400';
const TEXTAREA =
  'w-full resize-y rounded-md border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-800 outline-none transition-colors focus:border-[#3370ff] placeholder:text-stone-400';
const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-stone-500';

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 一段只有文本行的编辑器（前置 / 后置） */
function LineList({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <label className="block">
      <span className={SECTION_TITLE}>{label}（一行一条）</span>
      <textarea
        className={`${TEXTAREA} mt-1 min-h-[64px]`}
        value={value.join('\n')}
        placeholder={placeholder}
        onChange={(e) => onChange(lines(e.target.value))}
      />
    </label>
  );
}

/** 主流程：一行一步，用「动作 -> 结果」写；兼容全角箭头 */
function FlowEditor({
  value,
  onChange,
}: {
  value: ReqStory['mainFlow'];
  onChange: (next: ReqStory['mainFlow']) => void;
}) {
  return (
    <label className="block">
      <span className={SECTION_TITLE}>主流程（一行一步：动作 -&gt; 结果）</span>
      <textarea
        className={`${TEXTAREA} mt-1 min-h-[80px]`}
        value={value.map((s) => (s.result ? `${s.action} -> ${s.result}` : s.action)).join('\n')}
        placeholder="填写申请单 -> 进入待审批"
        onChange={(e) =>
          onChange(
            lines(e.target.value).map((line) => {
              const at = line.indexOf('->') >= 0 ? line.indexOf('->') : line.indexOf('→');
              if (at < 0) return { action: line };
              return {
                action: line.slice(0, at).trim(),
                result: line.slice(at + (line.startsWith('->', at) ? 2 : 1)).trim(),
              };
            }),
          )
        }
      />
    </label>
  );
}

/** 替代流程：每个流程一段，首行「名称 | 触发条件」，后续行是步骤 */
function AltFlowEditor({
  value,
  onChange,
}: {
  value: ReqStory['altFlows'];
  onChange: (next: ReqStory['altFlows']) => void;
}) {
  const text = value
    .map((flow) =>
      [`${flow.name} | ${flow.trigger}`, ...flow.steps.map((step, i) => `${i + 1}. ${step}`)].join(
        '\n',
      ),
    )
    .join('\n\n');
  return (
    <label className="block">
      <span className={SECTION_TITLE}>替代流程（空行分段：名称 | 触发条件，下面写步骤）</span>
      <textarea
        className={`${TEXTAREA} mt-1 min-h-[80px]`}
        value={text}
        placeholder={'转人工审批 | 金额超过 5 万\n1. 提交后进入人工队列\n2. 审批通过再继续'}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/\n{2,}/)
              .map((block) => {
                const rows = block
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean);
                const head = rows.shift() ?? '';
                const [name, trigger] = head.split('|');
                return {
                  name: (name ?? '').trim() || '替代流程',
                  trigger: (trigger ?? '').trim(),
                  steps: rows.map((x) => x.replace(/^\d+[.、)]\s*/, '')),
                };
              })
              .filter((flow) => flow.name !== '替代流程' || flow.steps.length || flow.trigger),
          )
        }
      />
    </label>
  );
}

/** 异常场景：一行一条，用「场景 -> 预期」 */
function ExceptionEditor({
  value,
  onChange,
}: {
  value: ReqStory['exceptions'];
  onChange: (next: ReqStory['exceptions']) => void;
}) {
  return (
    <label className="block">
      <span className={SECTION_TITLE}>异常场景（一行一条：场景 -&gt; 预期）</span>
      <textarea
        className={`${TEXTAREA} mt-1 min-h-[80px]`}
        value={value
          .map((e) => (e.expected ? `${e.scenario} -> ${e.expected}` : e.scenario))
          .join('\n')}
        placeholder="提交时网络中断 -> 提示重试并保留草稿"
        onChange={(e) =>
          onChange(
            lines(e.target.value).map((line) => {
              const at = line.indexOf('->') >= 0 ? line.indexOf('->') : line.indexOf('→');
              if (at < 0) return { scenario: line, expected: '' };
              return {
                scenario: line.slice(0, at).trim(),
                expected: line.slice(at + (line.startsWith('->', at) ? 2 : 1)).trim(),
              };
            }),
          )
        }
      />
    </label>
  );
}

/** 验收标准：一行一条，用 Given / When / Then 三个短句拼 */
function AcceptanceEditor({
  value,
  onChange,
}: {
  value: ReqStory['acceptance'];
  onChange: (next: ReqStory['acceptance']) => void;
}) {
  return (
    <label className="block">
      <span className={SECTION_TITLE}>验收标准（一行一条：Given | When | Then）</span>
      <textarea
        className={`${TEXTAREA} mt-1 min-h-[80px]`}
        value={value.map((a) => `${a.given} | ${a.when} | ${a.then}`).join('\n')}
        placeholder="已登录且有权限 | 提交申请单 | 列表里出现一条待审批记录"
        onChange={(e) =>
          onChange(
            lines(e.target.value).map((line) => {
              const [given = '', when = '', then = ''] = line.split('|').map((x) => x.trim());
              return { given, when, then };
            }),
          )
        }
      />
    </label>
  );
}

export default function ReqStoryCard({
  story,
  index,
  total,
  gaps,
  busy,
  onSave,
  onDelete,
  onMove,
  domId,
}: {
  story: ReqStory;
  index: number;
  total: number;
  gaps: ReqGap[];
  busy?: boolean;
  onSave: (next: ReqStory) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  /** 外部定位用（故事视图跳进来时滚动到这张卡） */
  domId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ReqStory>(story);

  const startEdit = () => {
    setDraft({ ...story });
    setEditing(true);
    setOpen(true);
  };
  const patch = (part: Partial<ReqStory>) => setDraft((prev) => ({ ...prev, ...part }));

  const highGaps = gaps.filter((gap) => gap.severity === 'high').length;

  return (
    <li id={domId} className="tw-pm-card rounded-xl border border-stone-200 bg-white">
      <div className="flex items-start gap-2 px-4 py-3">
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          aria-label={open ? '收起' : '展开'}
          onClick={() => setOpen((v) => !v)}
        >
          <PmIcon
            name="chevronRight"
            size={14}
            className={open ? 'rotate-90 transition-transform' : 'transition-transform'}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-500">
              {story.id || '待编号'}
            </span>
            <PmTag tone={REQ_PRIORITY_TONE[story.priority]}>{story.priority}</PmTag>
            <span className="truncate text-sm font-medium text-stone-800">{story.title}</span>
            {gaps.length > 0 ? (
              <PmTag tone={highGaps ? 'red' : 'amber'}>
                {gaps.length} 个缺口
                {highGaps ? ` · 高 ${highGaps}` : ''}
              </PmTag>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-stone-500">
            {[story.role && `角色：${story.role}`, story.goal && `目标：${story.goal}`]
              .filter(Boolean)
              .join(' · ') || '还没有写角色与目标'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 disabled:opacity-30"
            aria-label="上移"
            disabled={busy || index === 0}
            onClick={() => onMove(-1)}
          >
            <PmIcon name="chevronRight" size={14} className="-rotate-90" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 disabled:opacity-30"
            aria-label="下移"
            disabled={busy || index >= total - 1}
            onClick={() => onMove(1)}
          >
            <PmIcon name="chevronRight" size={14} className="rotate-90" />
          </button>
          <button
            type="button"
            className="rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            aria-label={editing ? '取消编辑' : '编辑'}
            onClick={() => (editing ? setEditing(false) : startEdit())}
          >
            <PmIcon name="pencil" size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
            aria-label="删除"
            disabled={busy}
            onClick={onDelete}
          >
            <PmIcon name="trash" size={14} />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-3 border-t border-stone-100 px-4 py-3">
          <label className="block">
            <span className={SECTION_TITLE}>标题</span>
            <input
              className={`${INPUT} mt-1`}
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={SECTION_TITLE}>角色</span>
              <input
                className={`${INPUT} mt-1`}
                value={draft.role}
                onChange={(e) => patch({ role: e.target.value })}
              />
            </label>
            <label className="block">
              <span className={SECTION_TITLE}>优先级</span>
              <div className="mt-1">
                <SelectDropdown
                  options={PRIORITY_OPTIONS}
                  value={draft.priority}
                  onChange={(next) => patch({ priority: next })}
                  ariaLabel="优先级"
                  flat
                />
              </div>
            </label>
          </div>
          <label className="block">
            <span className={SECTION_TITLE}>目标</span>
            <input
              className={`${INPUT} mt-1`}
              value={draft.goal}
              onChange={(e) => patch({ goal: e.target.value })}
            />
          </label>
          <label className="block">
            <span className={SECTION_TITLE}>价值 / 备注</span>
            <input
              className={`${INPUT} mt-1`}
              value={draft.value}
              onChange={(e) => patch({ value: e.target.value })}
            />
          </label>
          <LineList
            label="前置条件"
            value={draft.preconditions}
            placeholder="已登录且拥有申请权限"
            onChange={(next) => patch({ preconditions: next })}
          />
          <FlowEditor value={draft.mainFlow} onChange={(next) => patch({ mainFlow: next })} />
          <AltFlowEditor value={draft.altFlows} onChange={(next) => patch({ altFlows: next })} />
          <ExceptionEditor
            value={draft.exceptions}
            onChange={(next) => patch({ exceptions: next })}
          />
          <LineList
            label="后置条件"
            value={draft.postconditions}
            placeholder="申请单状态变为待审批"
            onChange={(next) => patch({ postconditions: next })}
          />
          <AcceptanceEditor
            value={draft.acceptance}
            onChange={(next) => patch({ acceptance: next })}
          />
          <LineList
            label="覆盖维度"
            value={draft.dimensions}
            placeholder="权限、边界值、超时与失败"
            onChange={(next) => patch({ dimensions: next })}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-stone-400">
              来源条目：{story.sourceRefs.join('、') || '（未关联）'}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="h-8 rounded-md border border-stone-200 px-3 text-xs text-stone-600 transition-colors hover:bg-stone-50"
                onClick={() => setEditing(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="h-8 rounded-md bg-[#3370ff] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={busy || !draft.title.trim()}
                onClick={() => {
                  onSave(draft);
                  setEditing(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {open && !editing ? (
        <div className="space-y-3 border-t border-stone-100 px-4 py-3 text-sm text-stone-700">
          {story.value ? (
            <p className="text-xs text-stone-500">价值 / 备注：{story.value}</p>
          ) : null}

          {story.preconditions.length ? (
            <div>
              <p className={SECTION_TITLE}>前置条件</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {story.preconditions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {story.mainFlow.length ? (
            <div>
              <p className={SECTION_TITLE}>主流程</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
                {story.mainFlow.map((step, i) => (
                  <li key={i}>
                    {step.actor ? `${step.actor}：` : ''}
                    {step.action}
                    {step.result ? <span className="text-stone-500"> → {step.result}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {story.altFlows.length ? (
            <div>
              <p className={SECTION_TITLE}>替代流程</p>
              <ul className="mt-1 space-y-1 text-sm">
                {story.altFlows.map((flow, i) => (
                  <li key={i}>
                    <span className="font-medium">{flow.name}</span>
                    {flow.trigger ? (
                      <span className="text-stone-500">（触发：{flow.trigger}）</span>
                    ) : null}
                    <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-stone-600">
                      {flow.steps.map((step, j) => (
                        <li key={j}>{step}</li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {story.exceptions.length ? (
            <div>
              <p className={SECTION_TITLE}>异常场景</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {story.exceptions.map((item, i) => (
                  <li key={i}>
                    {item.scenario}
                    {item.expected ? (
                      <span className="text-stone-500"> → {item.expected}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {story.postconditions.length ? (
            <div>
              <p className={SECTION_TITLE}>后置条件</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {story.postconditions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {story.acceptance.length ? (
            <div>
              <p className={SECTION_TITLE}>验收标准</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {story.acceptance.map((item, i) => (
                  <li key={i}>
                    <span className="text-stone-400">Given</span> {item.given || '—'}{' '}
                    <span className="text-stone-400">When</span> {item.when || '—'}{' '}
                    <span className="text-stone-400">Then</span>{' '}
                    <span className={item.then ? 'text-stone-700' : 'text-red-500'}>
                      {item.then || '（未写）'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {story.dimensions.length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className={SECTION_TITLE}>覆盖维度</span>
              {story.dimensions.map((dim) => (
                <span
                  key={dim}
                  className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500"
                >
                  {dim}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1 text-[11px] text-stone-400">
            <span>来源条目</span>
            {story.sourceRefs.length ? (
              story.sourceRefs.map((ref) => (
                <span
                  key={ref}
                  className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-stone-500"
                >
                  {ref}
                </span>
              ))
            ) : (
              <span className="text-amber-600">未关联（覆盖率会算不到）</span>
            )}
          </div>

          {gaps.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
              <p className="text-xs font-medium text-amber-900">体检发现的问题</p>
              <ul className="mt-1 space-y-1">
                {gaps.map((gap) => (
                  <li key={gap.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <PmTag tone={GAP_SEVERITY_TONE[gap.severity]}>
                      {GAP_SEVERITY_LABEL[gap.severity]}
                    </PmTag>
                    <span className="text-stone-500">{GAP_TYPE_LABEL[gap.type]}</span>
                    <span className="text-stone-700">{gap.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
