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
  'h-7 w-full rounded-md border border-stone-200 bg-white px-2 text-[11px] text-stone-700 outline-none transition-colors focus:border-[#3370ff]';

const STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: '待绑定', className: 'bg-stone-100 text-stone-500' },
  bound: { label: '已绑定', className: 'bg-emerald-50 text-emerald-600' },
  done: { label: '已完成', className: 'bg-emerald-50 text-emerald-600' },
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
}: {
  plan: UiPlanStep[];
  disabled?: boolean;
  onChange: (next: UiPlanStep[]) => void;
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-1 pb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-stone-600">步骤计划</span>
          {plan.length ? (
            <span className="text-[11px] text-stone-400">
              {boundCount}/{plan.length} 已绑定
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-[11px] text-[#3370ff] hover:underline disabled:opacity-40"
            onClick={append}
            disabled={disabled || plan.length >= 40}
          >
            + 添加
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-0.5">
        {plan.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-[11px] leading-relaxed text-stone-400">
            还没有步骤。
            <br />
            输入需求后点「生成步骤」，这里会出来一份可以手动调整的计划。
          </p>
        ) : null}

        {plan.map((step, index) => {
          const meta = STATUS_META[step.status] ?? STATUS_META.pending;
          const needsValue =
            step.action === 'fill' || step.action === 'select' || step.action === 'press';
          return (
            <div key={step.id} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5">
              <div className="flex items-center gap-1">
                <span className="w-4 shrink-0 text-center font-mono text-[10px] text-stone-400">
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
                    triggerClassName="flex h-6 w-full items-center gap-1 rounded-md border border-stone-200 bg-white px-1 text-[10px] text-stone-600 outline-none transition-colors hover:border-stone-300 focus:border-[#3370ff] disabled:cursor-not-allowed disabled:opacity-50"
                    menuMinWidth={120}
                  />
                </div>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${meta.className}`}>
                  {meta.label}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className="px-1 text-[11px] text-stone-400 hover:text-stone-700 disabled:opacity-30"
                    onClick={() => move(index, -1)}
                    disabled={disabled || index === 0}
                    aria-label="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="px-1 text-[11px] text-stone-400 hover:text-stone-700 disabled:opacity-30"
                    onClick={() => move(index, 1)}
                    disabled={disabled || index === plan.length - 1}
                    aria-label="下移"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="tw-icon-danger px-1 text-[11px]"
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
                <p className="mt-1 truncate font-mono text-[10px] text-emerald-700">
                  {formatLocator(step.locator)}
                </p>
              ) : null}
              {step.warning ? (
                <p className="mt-0.5 text-[10px] leading-4 text-amber-600">{step.warning}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
