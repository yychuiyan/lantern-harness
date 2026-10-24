/**
 * 用例质量评审面板：结论卡 + 五维 + 七项量化指标 + 逐条明细。
 * 只渲染，不自己算分（分数由 `src/lib/case-review.ts` 出）。
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  DIMENSION_META,
  VERDICT_META,
  VERDICT_ORDER,
  VERDICT_THRESHOLDS,
  type CaseReviewReport,
  type CaseVerdict,
  type Verdict,
} from '../../lib/case-review';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import type { PmTone } from './PmShared';

const TONE_TEXT: Record<PmTone, string> = {
  blue: 'text-sky-700',
  purple: 'text-violet-700',
  green: 'text-emerald-700',
  amber: 'text-amber-700',
  yellow: 'text-yellow-700',
  red: 'text-rose-700',
  gray: 'text-stone-600',
  muted: 'text-stone-500',
};

const TONE_BAR: Record<PmTone, string> = {
  blue: 'bg-sky-500',
  purple: 'bg-violet-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  yellow: 'bg-yellow-500',
  red: 'bg-rose-500',
  gray: 'bg-stone-400',
  muted: 'bg-stone-300',
};

function scoreTone(score: number): PmTone {
  if (score >= 85) return 'green';
  if (score >= 60) return 'amber';
  return 'red';
}

/** 「上次评审」的相对时间：本机时钟乱掉时不显示负值 */
function reviewAgeLabel(at: string): string {
  const ts = Date.parse(at);
  if (!Number.isFinite(ts)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

interface Props {
  review: CaseReviewReport | null;
  running: boolean;
  modelReady: boolean;
  onRun: () => void;
  onStop: () => void;
  /** 带着扣分原因跳到工作台，在那条用例绑定的会话里改文件 */
  onFix: (item: CaseVerdict) => void;
  /** 批量修改：把当前筛选出的「待修改 / 错误无效」一起交给工作台 */
  onFixBatch: (items: CaseVerdict[]) => void;
  onExport: () => void;
}

export default function CaseQualityPanel({
  review,
  running,
  modelReady,
  onRun,
  onStop,
  onFix,
  onFixBatch,
  onExport,
}: Props) {
  // 筛选 / 搜索 / 排序按空间记住：切 Tab、关抽屉、刷新后回来还是上次看的样子
  const [filter, setFilterState] = useState<Verdict | 'all'>(() =>
    readViewPref<Verdict | 'all'>('caseReview.quality.filter', ['all', ...VERDICT_ORDER], 'all'),
  );
  const [keyword, setKeywordState] = useState(() => readViewText('caseReview.quality.search'));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 「看到结论后怎么处理」默认收起：首屏先给结论与指标，需要时再展开 */
  const [guideOpen, setGuideOpen] = useState(false);
  /** 按分数升序：先看最差的几条 */
  const [worstFirst, setWorstFirstState] = useState(
    () => readViewPref('caseReview.quality.worstFirst', ['1', '0'], '0') === '1',
  );
  const setFilter = (v: Verdict | 'all') => {
    setFilterState(v);
    writeViewPref('caseReview.quality.filter', v);
  };
  const setKeyword = (v: string) => {
    setKeywordState(v);
    writeViewText('caseReview.quality.search', v);
  };
  const setWorstFirst = (v: boolean) => {
    setWorstFirstState(v);
    writeViewPref('caseReview.quality.worstFirst', v ? '1' : '0');
  };

  const cases = useMemo(() => review?.cases ?? [], [review]);
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    const list = cases.filter((c) => {
      if (filter !== 'all' && c.verdict !== filter) return false;
      if (!q) return true;
      return `${c.no} ${c.title}`.toLowerCase().includes(q);
    });
    // 排序会打乱「文件行序」，默认关；需要定位最差的几条时再打开
    return worstFirst ? [...list].sort((a, b) => a.score - b.score) : list;
  }, [cases, filter, keyword, worstFirst]);

  /** 批量修改的对象：当前筛选里非「可用」且未「已修改」的用例 */
  const fixableVisible = useMemo(
    () => filtered.filter((c) => c.verdict !== 'usable' && !c.fixed),
    [filtered],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="h-8 px-3 rounded-lg text-xs font-medium border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
          >
            停止评审
          </button>
        ) : (
          <button
            type="button"
            onClick={onRun}
            className="h-8 px-3 rounded-lg text-xs font-medium bg-stone-900 text-white hover:bg-stone-800"
          >
            {review ? '重新评审' : '开始评审'}
          </button>
        )}
        <button
          type="button"
          onClick={onExport}
          disabled={!review || running}
          className="h-8 px-3 rounded-lg text-xs border border-stone-200 text-stone-700 hover:bg-stone-50 disabled:opacity-40"
        >
          导出 Markdown
        </button>
        <span className="text-[11px] text-stone-400">
          {modelReady ? '规则 + 模型：语义问题与扣分原因由模型补' : '未配置模型：只跑规则判定'}
        </span>
        {review ? (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-stone-400">
            {review.modelCovered != null && review.modelCovered < cases.length ? (
              <span className="text-amber-700">
                模型只评到 {review.modelCovered}/{cases.length} 条，其余按规则分
              </span>
            ) : null}
            <span>上次评审：{reviewAgeLabel(review.at)}</span>
          </span>
        ) : null}
      </div>

      {!review ? (
        <div className="rounded-xl border border-dashed border-stone-200 px-6 py-12 text-center">
          <p className="text-sm text-stone-600">还没有评审结果</p>
          <p className="mt-1 text-xs text-stone-400">
            评审按五维打分（需求覆盖 / 步骤可执行 / 预期可判定 / 数据与边界 / 规范完整），
            算七项量化指标，并把每条判成「可用 / 待修改 / 错误无效」；只读不改用例。
          </p>
        </div>
      ) : (
        <>
          {/* 判定之后怎么处理：默认收起，首屏让给分数与指标；每条结论都对应一个动作 */}
          <section className="rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2">
            <button
              type="button"
              onClick={() => setGuideOpen((v) => !v)}
              className="flex w-full items-center gap-2 text-left"
            >
              <h3 className="text-xs font-semibold text-stone-700">看到结论后怎么处理</h3>
              <span className="text-[11px] text-stone-400">{guideOpen ? '收起' : '展开'}</span>
            </button>
            {guideOpen ? (
              <>
                <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-stone-600">
                  <li>
                    <span className={`mr-1 rounded border px-1 ${VERDICT_META.invalid.badge}`}>
                      错误无效
                    </span>
                    点这条右侧的「修改」，会带着编号、扣分原因与建议跳到工作台（用例绑定的会话，没有就新建），
                    让模型按建议改；跳转后本条标「已修改」。重新评审会跳过已修改条并记为可用，不再丢给模型重挑。
                  </li>
                  <li>
                    <span className={`mr-1 rounded border px-1 ${VERDICT_META.revise.badge}`}>
                      待修改
                    </span>
                    不影响执行，按建议补齐边界 / 异常 / 前置条件即可；批量改完再整体重评一次。
                  </li>
                  <li>
                    <span className="mr-1 rounded border border-stone-200 px-1 text-stone-600">
                      批量修改
                    </span>
                    在下面的「逐条明细」里：先按「错误无效 / 待修改」筛选（或搜索编号），
                    再点右侧「批量修改
                    N」，当前列出来的这批会一起交给工作台改；只改筛出来的，不会碰「可用」的。
                    自己分批手改也可以，AI 会按文件当前内容对照，不会覆盖你后来的手改。
                  </li>
                  <li>
                    <span className={`mr-1 rounded border px-1 ${VERDICT_META.usable.badge}`}>
                      可用
                    </span>
                    可直接执行或入库；这里只读，不会自动改你的用例文件。
                  </li>
                </ul>
                <p className="mt-1.5 text-[10px] text-stone-400">
                  改文件后报告会标「可能已过期」，重新评审即刷新；每次结果都存在「用例评审」目录里。
                </p>
              </>
            ) : null}
          </section>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5">
              <div className="text-[11px] text-stone-500">总分</div>
              <div className={`text-xl font-semibold ${TONE_TEXT[scoreTone(review.score)]}`}>
                {review.score}
              </div>
              <div className="text-[11px] text-stone-400">
                {review.modeled ? '规则 + 模型' : '仅规则'}
              </div>
            </div>
            {VERDICT_ORDER.map((v) => (
              <div key={v} className="rounded-xl border border-stone-200 bg-white px-3 py-2.5">
                <div className="text-[11px] text-stone-500">{VERDICT_META[v].label}</div>
                <div className={`text-xl font-semibold ${TONE_TEXT[VERDICT_META[v].tone]}`}>
                  {review.counts[v]}
                </div>
                <div className="text-[11px] text-stone-400">{VERDICT_META[v].hint}</div>
              </div>
            ))}
          </div>

          <section className="rounded-xl border border-stone-200 bg-white p-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-xs font-semibold text-stone-700">五维得分（整批平均）</h3>
              <span className="text-[10px] text-stone-400">
                每维 0–100 分；左侧百分比是权重，右侧数字才是这一维的得分
              </span>
            </div>
            {/* 表头：把「权重」与「得分」分开写清，避免把权重当成得分、把右侧数字当总分 */}
            <div className="mt-2 mb-1 flex items-center gap-2 text-[10px] text-stone-400">
              <span className="w-20 shrink-0">维度</span>
              <span className="w-9 shrink-0 text-right">权重</span>
              <span className="flex-1" />
              <span className="w-8 shrink-0 text-right">得分</span>
            </div>
            <div className="space-y-2">
              {review.dimensions.map((d) => (
                <div key={d.key} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-[11px] text-stone-600">{d.label}</span>
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-stone-400">
                    {d.weight}%
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className={`h-full ${TONE_BAR[DIMENSION_META[d.key]?.tone ?? 'gray']}`}
                      style={{ width: `${d.score}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-stone-700">
                    {d.score}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-stone-400">
              总分 {review.score} = 各维度得分 × 权重求和（不是右侧某个数字）； ≥{' '}
              {VERDICT_THRESHOLDS.usable} 可用 · {VERDICT_THRESHOLDS.revise}–
              {VERDICT_THRESHOLDS.usable - 1} 待修改 · &lt; {VERDICT_THRESHOLDS.revise} 错误无效。
            </p>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-3">
            <h3 className="mb-2 text-xs font-semibold text-stone-700">
              量化指标
              <span className="ml-1 font-normal text-stone-400">七项 + 硬伤条数</span>
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {review.metrics.map((m) => (
                <div
                  key={m.key}
                  className="rounded-lg border border-stone-100 bg-stone-50/60 px-2.5 py-2"
                >
                  <div className="text-[11px] text-stone-500">{m.label}</div>
                  <div className="text-base font-semibold text-stone-800 tabular-nums">
                    {m.text}
                  </div>
                  <div className="text-[10px] leading-tight text-stone-400">{m.hint}</div>
                </div>
              ))}
            </div>
          </section>

          {review.summary ? (
            <section className="rounded-xl border border-stone-200 bg-white p-3">
              <h3 className="mb-1 text-xs font-semibold text-stone-700">整体结论</h3>
              <p className="text-xs leading-relaxed text-stone-600 whitespace-pre-wrap">
                {review.summary}
              </p>
            </section>
          ) : null}

          <section className="rounded-xl border border-stone-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-3 py-2">
              <h3 className="text-xs font-semibold text-stone-700">逐条明细</h3>
              <div className="flex items-center gap-1">
                <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                  全部 {cases.length}
                </FilterChip>
                {VERDICT_ORDER.map((v) => (
                  <FilterChip key={v} active={filter === v} onClick={() => setFilter(v)}>
                    {VERDICT_META[v].label} {review.counts[v]}
                  </FilterChip>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setWorstFirst(!worstFirst)}
                className={`ml-auto h-6 shrink-0 rounded-md px-2 text-[11px] transition-colors ${
                  worstFirst ? 'bg-stone-900 text-white' : 'text-stone-500 hover:bg-stone-100'
                }`}
              >
                按分数升序
              </button>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜编号 / 标题"
                className="h-7 w-40 rounded-lg border border-stone-200 px-2 text-xs outline-none focus:border-stone-400"
              />
              <button
                type="button"
                disabled={!fixableVisible.length}
                onClick={() => onFixBatch(fixableVisible)}
                className="h-7 shrink-0 rounded-lg border border-stone-200 px-2 text-[11px] text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-40"
              >
                批量修改 {fixableVisible.length || ''}
              </button>
            </div>
            <ul className="divide-y divide-stone-100">
              {filtered.map((c, i) => (
                <CaseLine
                  key={`${c.no}-${i}`}
                  item={c}
                  open={expanded[`${c.no}-${i}`] === true}
                  onToggle={() =>
                    setExpanded((prev) => ({ ...prev, [`${c.no}-${i}`]: !prev[`${c.no}-${i}`] }))
                  }
                  onFix={() => onFix(c)}
                />
              ))}
              {!filtered.length ? (
                <li className="px-3 py-8 text-center text-xs text-stone-400">没有符合条件的用例</li>
              ) : null}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 rounded-md px-2 text-[11px] transition-colors ${
        active ? 'bg-stone-900 text-white' : 'text-stone-500 hover:bg-stone-100'
      }`}
    >
      {children}
    </button>
  );
}

function CaseLine({
  item,
  open,
  onToggle,
  onFix,
}: {
  item: CaseVerdict;
  open: boolean;
  onToggle: () => void;
  onFix: () => void;
}) {
  const meta = VERDICT_META[item.verdict];
  const fixable = item.verdict !== 'usable' && !item.fixed;
  return (
    // group：整行悬停时在标题右侧露出「修改」，行尾只固定留「得分 + 详情」
    <li className={`group px-3 py-2 ${item.fixed ? 'opacity-70' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full items-center gap-2 text-left"
      >
        {/* 徽标固定宽度：「可用 / 待修改 / 错误无效」字数不同，不固定会把编号列推得忽左忽右 */}
        <span
          className={`inline-flex w-14 shrink-0 items-center justify-center rounded border px-1 py-0.5 text-[10px] leading-4 ${meta.badge}`}
        >
          {meta.label}
        </span>
        <span className="w-16 shrink-0 truncate text-left text-[11px] tabular-nums leading-4 text-stone-500">
          {item.no || '—'}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-left text-xs leading-4 text-stone-800">
            {item.title || '（无标题）'}
          </span>
          {item.fixed ? (
            <span className="shrink-0 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] leading-none text-emerald-700">
              已修改
            </span>
          ) : null}
          {fixable ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFix();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-5 shrink-0 rounded-md border border-stone-200 px-1.5 text-[10px] leading-none text-stone-600 opacity-0 transition-opacity hover:bg-stone-100 focus-visible:opacity-100 group-hover:opacity-100"
            >
              修改
            </button>
          ) : null}
        </span>
        <span className="w-7 shrink-0 text-right text-[11px] tabular-nums leading-4 text-stone-500">
          {item.score}
        </span>
        <span className="flex h-5 w-8 shrink-0 items-center justify-center text-[10px] text-stone-400">
          {open ? '收起' : '详情'}
        </span>
      </div>
      {open ? (
        <div className="mt-2 space-y-2 pl-1">
          {item.hard ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
              硬伤：{item.hard}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(DIMENSION_META) as (keyof typeof DIMENSION_META)[]).map((key) => (
              <span
                key={key}
                className="rounded-md border border-stone-100 bg-stone-50 px-2 py-0.5 text-[10px] text-stone-600"
              >
                {DIMENSION_META[key].label} {item.dimensions[key]}
              </span>
            ))}
          </div>
          {item.deductions.length ? (
            <ul className="space-y-1.5">
              {item.deductions.map((d, i) => (
                <li key={i} className="rounded-md bg-stone-50 px-2 py-1.5">
                  <div className="text-[11px] text-stone-700">
                    <span className="mr-1 font-medium text-stone-500">
                      [{DIMENSION_META[d.dimension]?.label ?? d.dimension}
                      {d.points ? ` −${d.points}` : ''}]
                    </span>
                    {d.reason}
                  </div>
                  {d.suggestion ? (
                    <div className="mt-0.5 text-[11px] text-emerald-700">建议：{d.suggestion}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-stone-400">没有扣分项。</p>
          )}
        </div>
      ) : null}
    </li>
  );
}
