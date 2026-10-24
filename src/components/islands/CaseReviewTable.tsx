/**
 * 评审抽屉的「用例表格」Tab：固定六列（编号 / 标题 / 步骤 / 预期 / 判定 / 建议）。
 *
 * 作用：评审结论给的是「哪几条不能用」，这里能直接看到那几条的原步骤 / 预期，
 * 并且带上「改什么」，判断完可以直接点行内「修改」跳工作台。
 *
 * 列固定用标准字段：各项目的用例模板表头五花八门（标题列可能叫「测试项目」，预期列可能叫
 * 「期望内容标准」），按文件表头出列会让列名和列序跟着模板变。真实取值按 `case-fields` 的
 * 别名映射回标准字段，所以模板换了也照样能对上。所属模块 / 类型 / 优先级收进标题下的灰字，
 * 把宽度让给步骤与预期这两列最需要看的。
 *
 * 判定优先用已保存的评审报告（规则 + 模型复算的最终结论），没有报告时回落到规则体检，
 * 这样表格与「质量评审」不会出现两套分数。
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  VERDICT_META,
  VERDICT_ORDER,
  caseSuggestions,
  type CaseReviewReport,
  type CaseVerdict,
  type RuleAudit,
  type Verdict,
} from '../../lib/case-review';
import type { CaseFileData } from '../../lib/case-file';
import { CASE_FIELD_NAME, caseFieldMap, type CaseFieldKey } from '../../lib/case-fields';
import { readViewPref, readViewText, writeViewPref, writeViewText } from '../../lib/view-prefs';
import {
  STICKY_CELL_L,
  STICKY_HEAD_L_RESIZE,
  ColumnResizeHandle,
  useColumnWidths,
  useScrollEdges,
} from './ColumnResize';
import OverflowHint from './OverflowHint';

/** 标题下的副信息：模板里有这几列才显示，不单独占列 */
const META_FIELDS: CaseFieldKey[] = ['module', 'type', 'priority'];

/**
 * 列宽：都写成像素并允许拖拽。
 * 「修改建议」必须给足宽度——之前按百分比分，抽屉窄的时候被挤成一条竖线，
 * 一行建议竖着排十几行，表格高度全被它撑开。没有宽度的列吃剩余空间。
 */
const COLUMNS = [
  { key: 'no', width: 84, min: 72 },
  { key: 'title', width: 168, min: 120 },
  { key: 'steps', width: 200, min: 150 },
  { key: 'expected', width: 192, min: 150 },
  { key: 'verdict', width: 112, min: 104 },
  // 建议这一列最容易被挤成竖条，给足初始宽度（合计约等于抽屉内容宽，不出现横向滚动）
  { key: 'suggestions', width: 220, min: 200 },
  // 末尾填充列：吃掉剩余空间，让六列严格按像素渲染、可横向滚动
  { key: 'filler', filler: true },
] as const;

const COL_WIDTH_KEY = 'lh:case-review:cols:v1';

interface Props {
  file: CaseFileData | null;
  audit: RuleAudit | null;
  /** 已保存的评审报告：有就按它的判定显示（与质量评审一致） */
  review: CaseReviewReport | null;
  /** 用例文件名：有些模板把迭代名填进「测试项目」，标题下就不用再重复这个文件名了 */
  fileName?: string;
}

/** 文件名去掉扩展名，用来和「测试项目」这类值比对 */
function stemOf(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]+$/, '')
    .trim()
    .toLowerCase();
}

export default function CaseReviewTable({ file, audit, review, fileName }: Props) {
  const rows = useMemo(() => file?.rows ?? [], [file]);
  // 筛选项与搜索词按空间记住（切 Tab / 关抽屉 / 刷新后仍停在原处）
  const [filter, setFilterState] = useState<Verdict | 'all'>(() =>
    readViewPref<Verdict | 'all'>('caseReview.table.filter', ['all', ...VERDICT_ORDER], 'all'),
  );
  const [keyword, setKeywordState] = useState(() => readViewText('caseReview.table.search'));
  const setFilter = (v: Verdict | 'all') => {
    setFilterState(v);
    writeViewPref('caseReview.table.filter', v);
  };
  const setKeyword = (v: string) => {
    setKeywordState(v);
    writeViewText('caseReview.table.search', v);
  };
  const cols = useColumnWidths(COL_WIDTH_KEY, COLUMNS);
  const scrollRef = useScrollEdges('case-review');

  /** 标准字段 → 文件里真实的表头列（模板叫法不同也能取到值） */
  const map = useMemo(() => caseFieldMap(file?.headers ?? []), [file]);

  /** 每行的最终判定：报告按编号匹配，缺的再退回规则体检的同一行 */
  const verdicts = useMemo(() => {
    const byNo = new Map<string, CaseVerdict>();
    const byTitle = new Map<string, CaseVerdict>();
    for (const c of review?.cases ?? []) {
      if (c.no) byNo.set(c.no.trim(), c);
      if (c.title) byTitle.set(c.title.trim(), c);
    }
    return rows.map((row, i) => {
      const no = String(row[map.no ?? CASE_FIELD_NAME.no] ?? '').trim();
      const title = String(row[map.title ?? CASE_FIELD_NAME.title] ?? '').trim();
      return (
        (no ? byNo.get(no) : undefined) ??
        (title ? byTitle.get(title) : undefined) ??
        audit?.cases[i] ??
        null
      );
    });
  }, [rows, map, review, audit]);

  const counts = useMemo(() => {
    const acc: Record<Verdict, number> = { usable: 0, revise: 0, invalid: 0 };
    for (const v of verdicts) if (v) acc[v.verdict] += 1;
    return acc;
  }, [verdicts]);

  /** 行 + 判定 + 建议一起算出来，筛选直接在这份数据上做 */
  const lines = useMemo(() => {
    return rows.map((row, i) => {
      const v = verdicts[i];
      const cell = (key: CaseFieldKey) => String(row[map[key] ?? CASE_FIELD_NAME[key]] ?? '');
      // 「测试项目」常被填成迭代名 / 文件名，和标题下方的重复信息就不显示了
      const stem = fileName ? stemOf(fileName) : '';
      const meta = META_FIELDS.map(cell)
        .map((x) => x.trim())
        .filter((x) => Boolean(x) && (!stem || stemOf(x) !== stem))
        .join(' · ');
      return {
        key: i,
        no: cell('no'),
        title: cell('title'),
        meta,
        steps: cell('steps'),
        expected: cell('expected'),
        verdict: v,
        suggestions: v ? caseSuggestions(v) : [],
      };
    });
  }, [rows, map, verdicts, fileName]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return lines.filter((l) => {
      if (filter !== 'all' && l.verdict?.verdict !== filter) return false;
      if (!q) return true;
      return `${l.no} ${l.title}`.toLowerCase().includes(q);
    });
  }, [lines, filter, keyword]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-stone-400">
          {file ? `${rows.length} 条 · ${file.ext}` : '未读到用例文件'}
        </span>
        <div className="flex items-center gap-1">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
            全部 {lines.length}
          </FilterChip>
          {VERDICT_ORDER.map((v) => (
            <FilterChip key={v} active={filter === v} onClick={() => setFilter(v)}>
              {VERDICT_META[v].label} {counts[v]}
            </FilterChip>
          ))}
        </div>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜编号 / 标题"
          className="ml-auto h-7 w-40 rounded-lg border border-stone-200 px-2 text-xs outline-none focus:border-stone-400"
        />
      </div>
      <p className="text-[11px] text-stone-400">
        {review
          ? '只读对照：判定与「质量评审」一致；要改用例回「用例管理」，或在质量评审里点「修改」跳工作台。'
          : '只读对照：还没评审，先用规则体检结果；要改用例回「用例管理」。'}
        <span className="ml-1 text-stone-300">拖动表头右边缘可调列宽，双击恢复默认。</span>
      </p>
      <div className="-mt-2 flex justify-end"></div>

      {!rows.length ? (
        <p className="rounded-xl border border-dashed border-stone-200 px-6 py-12 text-center text-xs text-stone-400">
          没解析到用例行：确认第一行是表头，且有编号与标题列（也认「测试项目 /
          用例名称」这类叫法）。支持 md 表格、csv、xlsx。
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="tw-scroll-x max-h-[calc(100vh-300px)] overflow-auto rounded-xl border border-stone-200 bg-white"
        >
          <table className="tw-sticky-table table-fixed text-left text-xs" style={cols.tableStyle}>
            <colgroup>
              {COLUMNS.map((c) => (
                <col
                  key={c.key}
                  style={cols.widthOf(c.key) ? { width: cols.widthOf(c.key) } : undefined}
                />
              ))}
            </colgroup>
            <thead className="tw-table-head sticky top-0 z-10 text-[11px] text-stone-500">
              <tr>
                <th className={STICKY_HEAD_L_RESIZE}>
                  用例编号
                  <ColumnResizeHandle {...cols.resizeProps('no')} />
                </th>
                <th className="relative px-2.5 py-2 font-medium">
                  用例标题
                  <ColumnResizeHandle {...cols.resizeProps('title')} />
                </th>
                <th className="relative px-2.5 py-2 font-medium">
                  测试步骤
                  <ColumnResizeHandle {...cols.resizeProps('steps')} />
                </th>
                <th className="relative px-2.5 py-2 font-medium">
                  预期结果
                  <ColumnResizeHandle {...cols.resizeProps('expected')} />
                </th>
                <th className="relative px-2.5 py-2 font-medium whitespace-nowrap">
                  规则判定
                  <ColumnResizeHandle {...cols.resizeProps('verdict')} />
                </th>
                <th className="relative px-2.5 py-2 font-medium">
                  修改建议
                  <ColumnResizeHandle {...cols.resizeProps('suggestions')} />
                </th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((line) => {
                // 单独取出来再判空：属性链在 JSX 回调里不会保留收窄
                const item = line.verdict;
                return (
                  <tr key={line.key} className="align-top">
                    <td className={`${STICKY_CELL_L} tabular-nums text-stone-600`}>
                      <OverflowHint text={line.no || '—'} className="block truncate" />
                    </td>
                    <td className="px-2.5 py-1.5">
                      <OverflowHint
                        text={line.title || '（无标题）'}
                        className="block truncate text-stone-800"
                      />
                      {line.meta ? (
                        <div className="mt-0.5 truncate text-[10px] text-stone-400">
                          {line.meta}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2.5 py-1.5 text-stone-700">
                      <OverflowHint
                        text={line.steps}
                        clamp="y"
                        className="line-clamp-2 whitespace-pre-wrap break-words"
                      />
                    </td>
                    <td className="px-2.5 py-1.5 text-stone-700">
                      <OverflowHint
                        text={line.expected}
                        clamp="y"
                        className="line-clamp-2 whitespace-pre-wrap break-words"
                      />
                    </td>
                    <td className="px-2.5 py-1.5">
                      {item ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] ${VERDICT_META[item.verdict].badge}`}
                          >
                            {VERDICT_META[item.verdict].label} {item.score}
                          </span>
                          {item.fixed ? (
                            <span className="rounded border border-emerald-200 bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-700">
                              已修改
                            </span>
                          ) : null}
                          {item.hard && !item.fixed ? (
                            <span className="rounded border border-rose-200 bg-white px-1 py-0.5 text-[10px] text-rose-600">
                              硬伤
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[10px] text-stone-300">—</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5">
                      {line.suggestions.length ? (
                        <OverflowHint
                          text={line.suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
                          clamp="y"
                          className="line-clamp-2 whitespace-pre-wrap break-words text-[11px] text-stone-600"
                        />
                      ) : (
                        <span className="text-[10px] text-stone-300">—</span>
                      )}
                    </td>
                    <td aria-hidden="true" />
                  </tr>
                );
              })}
              {!filtered.length ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-xs text-stone-400">
                    没有符合条件的用例
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
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
