/**
 * 场景遗漏补全面板：四类盲区分组、逐条勾选、交给工作台写回原用例文件。
 *
 * 写回不再走服务端的「末尾追加」，而是跳到这条用例绑定的工作台会话，
 * 由模型按文件真实表头补行（写前备份），这样缺列 / 别名表头也能填对。
 */
import { useMemo, useState } from 'react';
import {
  BLINDSPOT_META,
  SEVERITY_META,
  groupBlindspots,
  type BlindspotItem,
  type BlindspotReport,
} from '../../lib/case-review';
import type { PmTone } from './PmShared';

const TONE_BADGE: Record<PmTone, string> = {
  blue: 'border-sky-200 bg-sky-50 text-sky-700',
  purple: 'border-violet-200 bg-violet-50 text-violet-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  yellow: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  red: 'border-rose-200 bg-rose-50 text-rose-700',
  gray: 'border-stone-200 bg-stone-50 text-stone-600',
  muted: 'border-stone-200 bg-white text-stone-400',
};

interface Props {
  report: BlindspotReport | null;
  loading: boolean;
  running: boolean;
  completing: boolean;
  modelReady: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleCategory: (ids: string[], on: boolean) => void;
  onDetect: () => void;
  onStop: () => void;
  onComplete: () => void;
  /** 跳工作台写回（不再是服务端追加） */
  onWriteback: () => void;
  onExport: () => void;
}

export default function CaseBlindspotPanel({
  report,
  loading,
  running,
  completing,
  modelReady,
  selected,
  onToggle,
  onToggleCategory,
  onDetect,
  onStop,
  onComplete,
  onWriteback,
  onExport,
}: Props) {
  /** 旧版本用服务端追加写回时会打 added 标记：这些条目已进过文件，不再参与勾选 */
  const items = useMemo(() => (report?.items ?? []).filter((x) => !x.added), [report]);
  const legacyAdded = (report?.items ?? []).filter((x) => x.added).length;
  const groups = useMemo(() => groupBlindspots(items), [items]);
  /** 折叠的分组 key：默认全展开 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const allIds = useMemo(() => items.map((x) => x.id), [items]);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* 这个 Tab 的作用：从需求反推「漏测的场景」，补成完整用例再写回文件 */}
      <p className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
        用途：找出「需求里有、用例里没有」的场景（非功能、安全边界、兼容性、隐藏业务规则），
        不是挑现有用例的毛病，而是补漏。流程：① 探测盲区 → ② 勾选要补的条目 → ③「补全选中」写全前置
        / 步骤 / 预期 →
        ④「去工作台写回」跳到绑定会话，按归属需求插到对应分组最后一行之后（写前备份，不动原有行；对不上组才落到末尾）。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onDetect}
          disabled={running || completing}
          className="h-8 px-3 rounded-lg text-xs font-medium bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {running ? '探测中…' : report ? '重新探测' : '探测盲区'}
        </button>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="h-8 px-3 rounded-lg text-xs border border-rose-200 text-rose-600 hover:bg-rose-50"
          >
            停止
          </button>
        ) : null}
        <button
          type="button"
          onClick={onComplete}
          disabled={!selected.size || completing || running}
          className="h-8 px-3 rounded-lg text-xs border border-stone-200 text-stone-700 hover:bg-stone-50 disabled:opacity-40"
        >
          {completing ? '补全中…' : `补全选中 ${selected.size || ''}`}
        </button>
        <button
          type="button"
          onClick={onWriteback}
          disabled={!selected.size || running || loading}
          className="h-8 px-3 rounded-lg text-xs font-medium border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
        >
          {`去工作台写回 ${selected.size || ''}`}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={!report}
          className="h-8 px-3 rounded-lg text-xs border border-stone-200 text-stone-700 hover:bg-stone-50 disabled:opacity-40"
        >
          导出 Markdown
        </button>
        <span className="ml-auto text-[11px] text-stone-400">
          {items.length ? `已选 ${selected.size} / 共 ${items.length}` : ''}
        </span>
        <button
          type="button"
          disabled={!allIds.length}
          onClick={() => onToggleCategory(allIds, !allOn)}
          className="h-6 shrink-0 rounded-md px-2 text-[11px] text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-40"
        >
          {allOn ? '清空' : '全选'}
        </button>
      </div>

      {!modelReady ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          场景探测要靠模型推理，先在设置里配好模型。
        </p>
      ) : null}

      {loading ? (
        <p className="py-8 text-center text-xs text-stone-400">读取中…</p>
      ) : !report || (!report.items.length && !running) ? (
        <div className="rounded-xl border border-dashed border-stone-200 px-6 py-12 text-center">
          <p className="text-sm text-stone-600">还没有探测结果</p>
          <p className="mt-1 text-xs text-stone-400">
            会从非功能、安全边界、兼容性与隐藏业务规则四个方向找现有用例的缺口。
          </p>
        </div>
      ) : (
        <>
          {report.summary ? (
            <p className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs leading-relaxed text-stone-600 whitespace-pre-wrap">
              {report.summary}
            </p>
          ) : null}
          {legacyAdded ? (
            <p className="text-[10px] text-stone-400">
              另有 {legacyAdded} 条旧版本已写回的条目，不再显示（避免重复补进文件）。
            </p>
          ) : null}

          {groups.map((group) => {
            const meta = BLINDSPOT_META[group.key];
            const ids = group.items.map((x) => x.id);
            const groupOn = ids.length > 0 && ids.every((id) => selected.has(id));
            const folded = collapsed.has(group.key);
            const pickedInGroup = ids.filter((id) => selected.has(id)).length;
            return (
              <section key={group.key} className="rounded-xl border border-stone-200 bg-white">
                <header className="flex items-center gap-2 border-b border-stone-100 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(group.key)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${TONE_BADGE[meta.tone]}`}
                    >
                      {meta.mark}
                    </span>
                    <h3 className="text-xs font-semibold text-stone-700">{meta.label}</h3>
                    <span className="text-[11px] text-stone-400">
                      {ids.length} 条{pickedInGroup ? ` · 已选 ${pickedInGroup}` : ''}
                    </span>
                    <span className="ml-auto text-[10px] text-stone-400">
                      {folded ? '展开' : '收起'}
                    </span>
                  </button>
                  {ids.length ? (
                    <button
                      type="button"
                      onClick={() => onToggleCategory(ids, !groupOn)}
                      className="h-6 shrink-0 rounded-md px-2 text-[11px] text-stone-500 transition-colors hover:bg-stone-100"
                    >
                      {groupOn ? '取消本类' : '全选本类'}
                    </button>
                  ) : null}
                </header>
                {folded ? null : (
                  <>
                    <p className="px-3 pt-2 text-[11px] text-stone-400">{meta.hint}</p>
                    <ul className="divide-y divide-stone-100">
                      {group.items.map((item) => (
                        <BlindspotLine
                          key={item.id}
                          item={item}
                          checked={selected.has(item.id)}
                          onToggle={() => onToggle(item.id)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </section>
            );
          })}
        </>
      )}

      {selected.size ? (
        <p className="sticky bottom-0 rounded-lg border border-stone-200 bg-white/95 px-3 py-2 text-[11px] text-stone-500 shadow-sm backdrop-blur">
          已选 {selected.size} 条：可以先「补全选中」把字段写全，也可以直接「去工作台写回」——
          会按归属需求插到对应分组下面（不是整份追加到末尾），写前自动备份。
        </p>
      ) : null}
    </div>
  );
}

function BlindspotLine({
  item,
  checked,
  onToggle,
}: {
  item: BlindspotItem;
  checked: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sev = SEVERITY_META[item.severity];
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-stone-900"
          aria-label={`选择 ${item.title}`}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 rounded border px-1 py-0.5 text-[10px] ${TONE_BADGE[sev.tone]}`}
            >
              {sev.label}
            </span>
            <span className="flex-1 min-w-0 text-xs text-stone-800">{item.title}</span>
            <span className="shrink-0 text-[10px] text-stone-400">{item.priority}</span>
          </div>
          {item.reqAnchor ? (
            <p className="mt-0.5 text-[11px] text-stone-400">归属：{item.reqAnchor}</p>
          ) : null}
          {item.why ? (
            <p className="mt-0.5 text-[11px] leading-relaxed text-stone-500">容易漏：{item.why}</p>
          ) : null}
        </button>
      </div>
      {open ? (
        <dl className="mt-2 space-y-1 rounded-md bg-stone-50 px-2 py-1.5 text-[11px] text-stone-600">
          <Field label="归属需求" value={item.reqAnchor} />
          <Field label="前置条件" value={item.precondition} />
          <Field label="步骤" value={item.steps.map((s, i) => `${i + 1}. ${s}`).join('  ')} />
          <Field label="预期" value={item.expected} />
        </dl>
      ) : null}
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-stone-400">{label}</dt>
      <dd className="flex-1 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
