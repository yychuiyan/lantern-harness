/**
 * 可编辑的步骤计划。
 *
 * 只描述「动作 + 目标」：定位器由探索时 probe 回填（绑定后这里只读展示）。
 * 用户可以增删、排序、改描述，改完由父组件防抖保存。
 */
import type { UiPlanStep, UiTestStep } from '../../lib/ui-auto-agent';
import { formatLocator } from '../../lib/ui-auto-agent';
import SelectDropdown from './SelectDropdown';

const ACTIONS: Array<{ value: UiTestStep['action']; label: string }> = [
  { value: 'goto', label: '打开页面' },
  { value: 'click', label: '点击' },
  { value: 'fill', label: '填写' },
  { value: 'select', label: '选择' },
  { value: 'press', label: '按键' },
  { value: 'hover', label: '悬停' },
  { value: 'expect', label: '断言元素' },
  { value: 'expectUrl', label: '断言地址' },
  { value: 'wait', label: '等待' },
];

const INPUT =
  'h-7 w-full rounded-md border border-stone-200/80 bg-white px-2 text-[12px] text-stone-700 outline-none transition-colors placeholder:text-stone-300 focus:border-[#4176e6] focus:ring-2 focus:ring-[#4176e6]/12';

const STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: '待绑定', className: 'bg-stone-100 text-stone-500' },
  bound: { label: '已绑定', className: 'bg-emerald-50 text-emerald-700' },
  done: { label: '已完成', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: '没绑上', className: 'bg-red-50 text-red-600' },
};

/** 新增 / 补号都走这里，保证 id 不重复 */
export function nextPlanId(plan: UiPlanStep[]): string {
  const used = new Set(plan.map((step) => step.id));
  let seq = plan.length + 1;
  while (used.has(`p${seq}`)) seq += 1;
  return `p${seq}`;
}

export default function UiAutoSteps({
  plan,
  disabled,
  onChange,
  compactHeader,
}: {
  plan: UiPlanStep[];
  disabled?: boolean;
  onChange: (next: UiPlanStep[]) => void;
  /** 编排详情左侧已有标题时，只保留计数与添加 */
  compactHeader?: boolean;
}) {
  const update = (id: string, patch: Partial<UiPlanStep>) => {
    onChange(plan.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  };

  const move = (index: number, delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= plan.length) return;
    const list = plan.slice();
    const [item] = list.splice(index, 1);
    list.splice(next, 0, item);
    onChange(list);
  };

  const remove = (id: string) => onChange(plan.filter((step) => step.id !== id));

  const append = () =>
    onChange([...plan, { id: nextPlanId(plan), action: 'click', target: '', status: 'pending' }]);

  const boundCount = plan.filter(
    (step) => step.status === 'bound' || step.status === 'done',
  ).length;
  const gapLocator = plan.filter(
    (step) =>
      step.action !== 'goto' &&
      step.action !== 'expectUrl' &&
      step.action !== 'wait' &&
      step.action !== 'press' &&
      !step.locator,
  ).length;
  const assertCount = plan.filter(
    (step) => step.action === 'expect' || step.action === 'expectUrl',
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex shrink-0 items-center gap-2 ${compactHeader ? 'mb-1.5' : 'mb-2'}`}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {!compactHeader && plan.length ? (
            <span className="text-[11px] tabular-nums text-stone-400">
              {boundCount}/{plan.length} 已绑定
            </span>
          ) : null}
          {gapLocator ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] text-amber-700 bg-amber-50">
              {gapLocator} 步缺定位器
            </span>
          ) : null}
          {plan.length && !assertCount ? (
            <span className="rounded px-1.5 py-0.5 text-[10px] text-stone-500 bg-stone-100">
              尚无断言
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-[#4176e6] transition-colors hover:bg-[#4176e6]/8 disabled:opacity-40"
          onClick={append}
          disabled={disabled || plan.length >= 40}
        >
          + 添加
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-0.5">
        {plan.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-200 bg-white/80 px-3 py-10 text-center text-[12px] leading-relaxed text-stone-400">
            还没有步骤
            <br />
            在对话里描述需求后生成，或点右上角手动添加
          </p>
        ) : null}

        {plan.map((step, index) => {
          const meta = STATUS_META[step.status] ?? STATUS_META.pending;
          const needsValue =
            step.action === 'fill' || step.action === 'select' || step.action === 'press';
          const needsLocator =
            step.action !== 'goto' &&
            step.action !== 'expectUrl' &&
            step.action !== 'wait' &&
            step.action !== 'press' &&
            !step.locator;
          const isAssert = step.action === 'expect' || step.action === 'expectUrl';
          return (
            <div
              key={step.id}
              className="rounded-lg border border-stone-200/90 bg-white px-2 py-1.5 transition-colors hover:border-stone-300"
            >
              <div className="flex items-center gap-1">
                <span className="w-4 shrink-0 text-center font-mono text-[10px] tabular-nums text-stone-400">
                  {index + 1}
                </span>
                <div className="w-[88px] shrink-0">
                  <SelectDropdown
                    options={ACTIONS}
                    value={step.action}
                    onChange={(value) => update(step.id, { action: value })}
                    disabled={disabled}
                    unstyled
                    ariaLabel="步骤动作"
                    triggerClassName="flex h-6 w-full items-center gap-1 rounded-md border border-stone-200 bg-white px-1.5 text-[11px] text-stone-600 outline-none transition-colors hover:border-stone-300 focus:border-[#4176e6] disabled:cursor-not-allowed disabled:opacity-50"
                    menuMinWidth={120}
                  />
                </div>
                <span
                  className={`shrink-0 rounded px-1 py-px text-[10px] leading-4 ${meta.className}`}
                >
                  {meta.label}
                </span>
                {needsLocator ? (
                  <span className="shrink-0 rounded px-1 py-px text-[10px] leading-4 text-amber-700 bg-amber-50">
                    缺定位器
                  </span>
                ) : null}
                {isAssert ? (
                  <span className="shrink-0 rounded px-1 py-px text-[10px] leading-4 text-sky-700 bg-sky-50">
                    断言
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center opacity-60 transition-opacity hover:opacity-100">
                  <button
                    type="button"
                    className="flex h-6 w-5 items-center justify-center text-[11px] text-stone-400 hover:text-stone-700 disabled:opacity-30"
                    onClick={() => move(index, -1)}
                    disabled={disabled || index === 0}
                    aria-label="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="flex h-6 w-5 items-center justify-center text-[11px] text-stone-400 hover:text-stone-700 disabled:opacity-30"
                    onClick={() => move(index, 1)}
                    disabled={disabled || index === plan.length - 1}
                    aria-label="下移"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="tw-icon-danger flex h-6 w-5 items-center justify-center text-[12px]"
                    onClick={() => remove(step.id)}
                    disabled={disabled}
                    aria-label="删除"
                  >
                    ×
                  </button>
                </div>
              </div>

              <input
                className={`${INPUT} mt-1`}
                value={step.target}
                disabled={disabled}
                placeholder={step.action === 'goto' ? '打开哪个页面' : '目标描述，例如「登录按钮」'}
                onChange={(event) => update(step.id, { target: event.target.value })}
                spellCheck={false}
              />

              {step.action === 'goto' || step.action === 'expectUrl' ? (
                <input
                  className={`${INPUT} mt-1 font-mono`}
                  value={step.url ?? ''}
                  disabled={disabled}
                  placeholder="/login"
                  onChange={(event) => update(step.id, { url: event.target.value })}
                  spellCheck={false}
                />
              ) : null}

              {needsValue ? (
                <input
                  className={`${INPUT} mt-1 font-mono`}
                  value={step.value ?? ''}
                  disabled={disabled}
                  placeholder={step.action === 'press' ? 'Enter' : '输入值 / 选项（${ENV} 占位）'}
                  onChange={(event) => update(step.id, { value: event.target.value })}
                  spellCheck={false}
                />
              ) : null}

              {step.locator ? (
                <p className="mt-1 truncate font-mono text-[10px] leading-4 text-emerald-700/90">
                  {formatLocator(step.locator)}
                </p>
              ) : null}
              {step.warning ? (
                <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-amber-600">
                  {step.warning}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
