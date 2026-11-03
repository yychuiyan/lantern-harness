/**
 * Objective 目标：按年度周期分组、批量删除、右侧抽屉、行内改。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  QUARTERS,
  QUARTER_LABEL,
  filterByKeyword,
  objectiveKeyResults,
  objectiveProgress,
  yearCycleLabel,
  type ObjectiveItem,
  type Quarter,
  type YearCycleItem,
  type YearPlanItem,
} from '../../lib/life';
import ConfirmDialog from './ConfirmDialog';
import {
  ColumnResizeHandle,
  STICKY_CELL_L,
  STICKY_CELL_R,
  STICKY_HEAD_L_RESIZE,
  STICKY_HEAD_R,
  useColumnWidths,
  useScrollEdges,
} from './ColumnResize';
import { DRAWER_INPUT, DrawerField as FieldRow, IconTask, IconText } from './DrawerField';
import LifeYearCycleSelect from './LifeYearCycleSelect';
import SelectDropdown from './SelectDropdown';
import OverflowHint from './OverflowHint';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  ReadonlyCell,
  LifeAddRecordRow,
  LifeDeleteButton,
  LifeFieldConfigButton,
  filterLifeCols,
  LifeDrawer,
  LifeErrorBar,
  LifeExpandButton,
  LIFE_EMPTY_SELECT_TRIGGER,
  LIFE_FILLED_PILL_TRIGGER,
  LIFE_TH,
  LIFE_UNSELECTED_LABEL,
  LIFE_YEAR_UNSET_LABEL,
  LifeGroupHeader,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  LifeLoading,
  LifeNotice,
  LifeProgressBar,
  LifeSelectCell,
  LifeSelectHead,
  TextCell,
  collectNestItemIds,
  flattenLifeNestGroups,
  lifeCatalogCellClass,
  lifePluginDisabledMessage,
  sortByCreated,
  useLifeEnumPref,
  useLifeKeyword,
  useLifePlugin,
  useLifeSelection,
  useLifeStore,
  LIFE_NEW_ROW_TITLE_INPUT,
  useLifeFieldVisibility,
  useLifeInlineNewRow,
  type LifeNestGroup,
} from './LifeShared';

const COLS = [
  { key: 'select', width: 36, min: 32 },
  { key: 'title', width: 260, min: 180 },
  { key: 'yearCycle', width: 120, min: 88 },
  { key: 'yearPlanId', width: 160, min: 120 },
  { key: 'quarter', width: 140, min: 100 },
  { key: 'keyResults', width: 220, min: 140 },
  { key: 'progress', width: 120, min: 96 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'yearCycle', label: '年度周期' },
  { key: 'yearPlanId', label: '年度计划' },
  { key: 'quarter', label: '季度周期' },
  { key: 'keyResults', label: '关键结果' },
  { key: 'progress', label: '完成度' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.objectives.fields';

const KEYWORD_PREF = 'life.objectives.search';
const GROUP_PREF = 'life.objectives.group';
const GROUP_VALUES = ['yearQuarter', 'yearCycle', 'none'] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const QUARTER_GROUP_ORDER: readonly (Quarter | 'unset')[] = ['Q1', 'Q2', 'Q3', 'Q4', 'unset'];
const QUARTER_GROUP_PILL: Record<Quarter | 'unset', string> = {
  Q1: 'bg-[#e1eaff] text-[#1f4ec2]',
  Q2: 'bg-[#d9f5d2] text-[#1d7a12]',
  Q3: 'bg-[#fff1e3] text-[#a85b00]',
  Q4: 'bg-[#fee4e3] text-[#c02a26]',
  unset: 'bg-stone-300 text-stone-600',
};

function quarterPillKey(q: string): Quarter | 'unset' {
  return q === 'Q1' || q === 'Q2' || q === 'Q3' || q === 'Q4' ? q : 'unset';
}

const QUARTER_OPTIONS = QUARTERS.filter((q) => q !== '').map((q) => ({
  value: q,
  label: QUARTER_LABEL[q],
}));

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'yearQuarter', label: '按年度 → 季度周期' },
  { value: 'yearCycle', label: '按年度周期分组' },
];

type Draft = { title: string; yearCycle: string; yearPlanId: string; quarter: Quarter };

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    yearCycle: preset?.yearCycle ?? '',
    yearPlanId: preset?.yearPlanId ?? '',
    quarter: preset?.quarter ?? '',
  };
}

function yearPlanOptions(yearPlans: readonly YearPlanItem[]) {
  return [...yearPlans]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map((p) => ({ value: p.id, label: p.title }));
}

function yearPlanTitle(yearPlans: readonly YearPlanItem[], id: string): string {
  if (!id) return '';
  return yearPlans.find((p) => p.id === id)?.title ?? '';
}

type YearCycleMutate = {
  createItems: ReturnType<typeof useLifeStore>['createItems'];
  updateItem: ReturnType<typeof useLifeStore>['updateItem'];
  deleteItems: ReturnType<typeof useLifeStore>['deleteItems'];
};

function presetFromGroupKey(key: string): Partial<Draft> {
  const out: Partial<Draft> = {};
  const yearMatch = /(?:^|\|)year:([^|]*)/.exec(key);
  if (yearMatch) out.yearCycle = yearMatch[1] ?? '';
  const quarter = /(?:^|\|)quarter:([^|]+)/.exec(key)?.[1];
  if (quarter === 'unset' || quarter === 'other') out.quarter = '';
  else if (quarter === 'Q1' || quarter === 'Q2' || quarter === 'Q3' || quarter === 'Q4') {
    out.quarter = quarter;
  }
  return out;
}

type NewRow = Draft & {
  groupKey: string;
  baseYearCycle: string;
  baseYearPlanId: string;
  baseQuarter: Quarter;
};

function firstLeafNestKey(groups: LifeNestGroup<ObjectiveItem>[]): string {
  for (const n of groups) {
    if (n.children?.length) {
      const k = firstLeafNestKey(n.children);
      if (k) return k;
    } else if (n.items !== undefined) return n.key;
  }
  return 'all';
}

function ObjectiveDrawer(props: {
  open: boolean;
  item: ObjectiveItem;
  yearCycles: readonly YearCycleItem[];
  yearCycleMutate: YearCycleMutate;
  yearPlans: readonly YearPlanItem[];
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const { open, item, yearCycles, yearCycleMutate, yearPlans, isVisible, onClose, onSave } = props;
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const planOpts = useMemo(() => yearPlanOptions(yearPlans), [yearPlans]);

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft({
      title: item.title,
      yearCycle: item.yearCycle,
      yearPlanId: item.yearPlanId || '',
      quarter: item.quarter,
    });
  }, [open, item]);

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写目标描述');
      return;
    }
    setBusy(true);
    try {
      await onSave(
        {
          ...draft,
          title,
          yearCycle: draft.yearCycle,
          yearPlanId: draft.yearPlanId,
        },
        item.id,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function pickYearPlan(next: string) {
    const plan = yearPlans.find((p) => p.id === next);
    setDraft({
      ...draft,
      yearPlanId: next,
      yearCycle: plan?.yearCycle || draft.yearCycle,
    });
  }

  return (
    <LifeDrawer
      open={open}
      title="目标详情"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-stone-200 px-4 text-sm text-stone-700 hover:bg-stone-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="h-9 rounded-lg bg-[#3370ff] px-4 text-sm font-medium text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {error ? <p className="mx-6 mb-2 text-sm text-red-600">{error}</p> : null}
      <FieldRow icon={<IconText />} label="目标描述">
        <input
          autoFocus
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="请输入内容"
          className={DRAWER_INPUT}
        />
      </FieldRow>
      {isVisible('yearCycle') ? (
        <FieldRow icon={<IconTask />} label="年度周期">
          <LifeYearCycleSelect
            flat
            className="w-full"
            yearCycles={yearCycles}
            value={draft.yearCycle}
            onChange={(next) => {
              const plan = yearPlans.find((p) => p.id === draft.yearPlanId);
              const mismatch = Boolean(
                draft.yearPlanId && plan?.yearCycle && plan.yearCycle !== next,
              );
              setDraft({
                ...draft,
                yearCycle: next,
                ...(mismatch ? { yearPlanId: '' } : null),
              });
            }}
            mutate={yearCycleMutate}
            renderTrigger={(label, { empty }) => (
              <OverflowHint
                text={label}
                className={`block min-w-0 flex-1 basis-0 truncate ${
                  empty ? 'text-stone-400' : 'text-stone-800'
                }`}
              />
            )}
          />
        </FieldRow>
      ) : null}
      {isVisible('yearPlanId') ? (
        <FieldRow icon={<IconTask />} label="年度计划">
          <SelectDropdown
            flat
            searchable
            searchPlaceholder="搜索年度计划…"
            ariaLabel="年度计划"
            options={planOpts}
            value={draft.yearPlanId}
            onChange={pickYearPlan}
            className="w-full"
            renderTrigger={() => {
              const label = yearPlanTitle(yearPlans, draft.yearPlanId);
              return (
                <OverflowHint
                  text={label || LIFE_UNSELECTED_LABEL}
                  className={`block min-w-0 truncate ${
                    label ? 'text-stone-800' : 'text-stone-400'
                  }`}
                />
              );
            }}
          />
        </FieldRow>
      ) : null}
      {isVisible('quarter') ? (
        <FieldRow icon={<IconTask />} label="季度周期">
          <SelectDropdown
            flat
            searchable
            searchPlaceholder="搜索季度周期…"
            ariaLabel="季度周期"
            options={QUARTER_OPTIONS}
            value={draft.quarter}
            onChange={(next) => setDraft({ ...draft, quarter: next as Quarter })}
            className="w-full"
            renderTrigger={() => (
              <OverflowHint
                text={draft.quarter ? QUARTER_LABEL[draft.quarter] : LIFE_UNSELECTED_LABEL}
                className={`block min-w-0 truncate ${draft.quarter ? 'text-stone-800' : 'text-stone-400'}`}
              />
            )}
          />
        </FieldRow>
      ) : null}

      {isVisible('createdAt') ? (
        <FieldRow icon={<IconTask />} label="创建日期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {formatLifeTimestamp(item.createdAt)}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('updatedAt') ? (
        <FieldRow icon={<IconTask />} label="修改日期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {formatLifeTimestamp(item.updatedAt)}
          </div>
        </FieldRow>
      ) : null}
    </LifeDrawer>
  );
}

export default function LifeObjectivesBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const yearCycleMutate = useMemo(
    () => ({ createItems, updateItem, deleteItems }),
    [createItems, updateItem, deleteItems],
  );
  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const nestIndent = groupBy === 'yearQuarter';
  const titleStickyStyle = lifeStickyTitleStyle(nestIndent) as CSSProperties;
  const visibleCols = useMemo(() => {
    const w = lifeSelectColPx(nestIndent);
    return filterLifeCols(COLS, fields.isVisible).map((c) =>
      c.key === 'select' ? { ...c, width: w, min: w } : c,
    );
  }, [fields.isVisible, nestIndent]);
  const [deleteTargets, setDeleteTargets] = useState<ObjectiveItem[] | null>(null);
  const [editItem, setEditItem] = useState<ObjectiveItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<ObjectiveItem>>>({});
  const [newRow, setNewRow] = useState<NewRow | null>(null);

  const cols = useColumnWidths('life.objectives.cols.v13', visibleCols);
  const planOpts = useMemo(() => yearPlanOptions(store.yearPlans), [store.yearPlans]);
  const scrollRef = useScrollEdges('life.objectives');

  const filtered = useMemo(
    () => sortByCreated(filterByKeyword(store.objectives, keyword)),
    [store.objectives, keyword],
  );

  const nestGroups = useMemo<LifeNestGroup<ObjectiveItem>[]>(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '全部目标', pill: 'bg-stone-500 text-white', items: filtered }];
    }
    const yearIdOf = (o: ObjectiveItem) => o.yearCycle.trim();
    const yearLabelOf = (id: string) =>
      id ? yearCycleLabel(store.yearCycles, id) || LIFE_YEAR_UNSET_LABEL : LIFE_YEAR_UNSET_LABEL;
    const yearIds = [...new Set(filtered.map(yearIdOf))];
    yearIds.sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return yearLabelOf(b).localeCompare(yearLabelOf(a), undefined, { numeric: true });
    });

    // 无数据时 flatten 会跳过「空父级 + 空季度子级」，导致「+ 新建目标」写入的 draft 无处渲染
    if (yearIds.length === 0) {
      return [
        {
          key: 'year:',
          label: LIFE_YEAR_UNSET_LABEL,
          pill: lifeCatalogCellClass(''),
          items: [] as ObjectiveItem[],
        },
      ];
    }

    if (groupBy === 'yearCycle') {
      return yearIds.map((id) => {
        const inYear = filtered.filter((o) => yearIdOf(o) === id);
        const label = yearLabelOf(id);
        return {
          key: `year:${id}`,
          label,
          pill: lifeCatalogCellClass(id),
          items: inYear,
        };
      });
    }

    // 年度 → 季度周期：只保留有数据的季度组，避免空 Q1/Q3… 撑出多行「假记录」
    return yearIds
      .map((id) => {
        const inYear = filtered.filter((o) => yearIdOf(o) === id);
        const label = yearLabelOf(id);
        const children = QUARTER_GROUP_ORDER.map((q) => {
          const qLabel = q === 'unset' ? LIFE_UNSELECTED_LABEL : QUARTER_LABEL[q];
          const items = inYear.filter(
            (o) => (o.quarter || 'unset') === (q === 'unset' ? 'unset' : q),
          );
          return {
            key: `year:${id}|quarter:${q}`,
            label: qLabel,
            pill: QUARTER_GROUP_PILL[q],
            items,
          };
        });
        const matched = new Set(children.flatMap((c) => c.items.map((x) => x.id)));
        const orphans = inYear.filter((o) => !matched.has(o.id));
        if (orphans.length > 0) {
          children.push({
            key: `year:${id}|quarter:other`,
            label: '其它',
            pill: QUARTER_GROUP_PILL.unset,
            items: orphans,
          });
        }
        return {
          key: `year:${id}`,
          label,
          pill: lifeCatalogCellClass(id),
          children: children.filter((c) => c.items.length > 0),
        };
      })
      .filter((y) => (y.children?.length ?? 0) > 0);
  }, [groupBy, filtered, store.yearCycles]);

  const flatGroups = useMemo(
    () => flattenLifeNestGroups(nestGroups, groupBy === 'none' ? {} : collapsed),
    [nestGroups, collapsed, groupBy],
  );
  const visibleIds = useMemo(
    () => collectNestItemIds(nestGroups, groupBy === 'none' ? {} : collapsed),
    [nestGroups, collapsed, groupBy],
  );
  const selection = useLifeSelection(visibleIds);

  const { submit: submitNewRow } = useLifeInlineNewRow({
    row: newRow,
    setRow: setNewRow,
    submitting: adding,
    isPristine: (row) =>
      !row.title.trim() &&
      row.yearCycle === row.baseYearCycle &&
      row.yearPlanId === row.baseYearPlanId &&
      row.quarter === row.baseQuarter,
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('objectives', [
          {
            title: row.title,
            yearCycle: row.yearCycle,
            yearPlanId: row.yearPlanId,
            quarter: row.quarter,
          },
        ]);
        setNewRow(null);
        showToast('已新增 Objective', 'success');
        setError('');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        showToast(`新增失败：${msg}`, 'error');
      } finally {
        setAdding(false);
      }
    },
  });

  function startNewRow(groupKey: string, preset?: Partial<Draft>) {
    const yearCycle = preset?.yearCycle ?? '';
    const yearPlanId = preset?.yearPlanId ?? '';
    const quarter = preset?.quarter ?? '';
    setNewRow({
      groupKey,
      title: '',
      yearCycle,
      yearPlanId,
      quarter,
      baseYearCycle: yearCycle,
      baseYearPlanId: yearPlanId,
      baseQuarter: quarter,
    });
    setCollapsed((prev) => ({ ...prev, [groupKey]: false }));
  }

  function applyYearPlanPick(
    yearPlanId: string,
    currentYearCycle: string,
  ): { yearPlanId: string; yearCycle: string } {
    const plan = store.yearPlans.find((p) => p.id === yearPlanId);
    return {
      yearPlanId,
      yearCycle: plan?.yearCycle || currentYearCycle,
    };
  }

  async function patch(id: string, patchBody: Record<string, unknown>) {
    try {
      await updateItem('objectives', id, patchBody);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`保存失败：${msg}`, 'error');
    }
  }

  function draftOf(item: ObjectiveItem): ObjectiveItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patch: Partial<ObjectiveItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function commitDraft(item: ObjectiveItem) {
    const d = drafts[item.id];
    if (!d) return;
    const title = (d.title ?? item.title).trim();
    if (!title) {
      setError('目标描述不能为空');
      return;
    }
    await patch(item.id, { ...d, title });
  }

  async function saveFromDrawer(draft: Draft, id: string) {
    await updateItem('objectives', id, draft);
    showToast('已保存', 'success');
  }

  async function confirmDelete() {
    const targets = deleteTargets;
    if (!targets?.length) return;
    setDeleteTargets(null);
    setBusy(true);
    try {
      await deleteItems(
        'objectives',
        targets.map((t) => t.id),
      );
      selection.clear();
      showToast(targets.length > 1 ? `已删除 ${targets.length} 条` : '已删除', 'success');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderNewRow() {
    if (!newRow) return null;
    return (
      <tr className="tw-new-row">
        <td className="px-2 py-1 align-middle" />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <input
            autoFocus
            disabled={adding}
            value={newRow.title}
            placeholder="输入目标名称，回车或点空白处保存"
            onChange={(e) =>
              setNewRow((prev) => (prev ? { ...prev, title: e.target.value } : prev))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submitNewRow();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setNewRow(null);
              }
            }}
            className={LIFE_NEW_ROW_TITLE_INPUT}
          />
        </td>
        {fields.isVisible('yearCycle') ? (
          <td className="px-1 py-1 align-middle">
            <LifeYearCycleSelect
              unstyled
              pill
              yearCycles={store.yearCycles}
              value={newRow.yearCycle}
              onChange={(v) =>
                setNewRow((prev) => {
                  if (!prev) return prev;
                  const plan = store.yearPlans.find((p) => p.id === prev.yearPlanId);
                  const mismatch = Boolean(
                    prev.yearPlanId && plan?.yearCycle && plan.yearCycle !== v,
                  );
                  return {
                    ...prev,
                    yearCycle: v,
                    ...(mismatch ? { yearPlanId: '' } : null),
                  };
                })
              }
              mutate={yearCycleMutate}
            />
          </td>
        ) : null}
        {fields.isVisible('yearPlanId') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent={Boolean(newRow.yearPlanId)}
              searchable
              searchPlaceholder="搜索年度计划…"
              ariaLabel="年度计划"
              options={planOpts}
              value={newRow.yearPlanId}
              onChange={(next) =>
                setNewRow((prev) =>
                  prev ? { ...prev, ...applyYearPlanPick(next, prev.yearCycle) } : prev,
                )
              }
              triggerClassName={
                newRow.yearPlanId ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() => {
                const label = yearPlanTitle(store.yearPlans, newRow.yearPlanId);
                return label ? (
                  <span className="inline-flex h-7 max-w-full items-center truncate rounded-md bg-[#e8f0fe] px-2 text-xs font-medium text-[#1f4ec2]">
                    <OverflowHint text={label} className="block min-w-0 truncate" />
                  </span>
                ) : (
                  <OverflowHint
                    text={LIFE_UNSELECTED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                );
              }}
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent={Boolean(newRow.quarter)}
              searchable
              searchPlaceholder="搜索季度周期…"
              ariaLabel="季度周期"
              options={QUARTER_OPTIONS}
              value={newRow.quarter}
              onChange={(next) =>
                setNewRow((prev) => (prev ? { ...prev, quarter: next as Quarter } : prev))
              }
              triggerClassName={
                newRow.quarter ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() =>
                newRow.quarter ? (
                  <span
                    className={`inline-flex h-7 max-w-full items-center truncate rounded-md px-2 text-xs font-medium ${QUARTER_GROUP_PILL[quarterPillKey(newRow.quarter)]}`}
                  >
                    <OverflowHint
                      text={QUARTER_LABEL[newRow.quarter]}
                      className="block min-w-0 truncate"
                    />
                  </span>
                ) : (
                  <OverflowHint
                    text={LIFE_UNSELECTED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                )
              }
            />
          </td>
        ) : null}
        {fields.isVisible('keyResults') ? (
          <td className="px-2 py-1 align-middle text-xs text-stone-400">—</td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressBar value={0} />
          </td>
        ) : null}
        {fields.isVisible('createdAt') ? (
          <td className="px-1.5 py-1 align-middle">
            <ReadonlyCell text="—" muted />
          </td>
        ) : null}
        {fields.isVisible('updatedAt') ? (
          <td className="px-1.5 py-1 align-middle">
            <ReadonlyCell text="—" muted />
          </td>
        ) : null}
        <td aria-hidden="true" />
        <td className={STICKY_CELL_R} />
      </tr>
    );
  }

  function renderRow(item: ObjectiveItem, index: number, depth = 0) {
    const row = draftOf(item);
    const krs = objectiveKeyResults(row.id, store.krTasks);
    const progress = objectiveProgress(row.id, store.krTasks, store.krTodos);
    return (
      <tr key={item.id} className="group/row tw-life-group-body hover:bg-[#f7f8fa]">
        <LifeSelectCell
          checked={Boolean(selection.selected[item.id])}
          onChange={() => selection.toggle(item.id)}
          label={`选择 ${item.title}`}
          index={index}
          selecting={selection.selectedIds.length > 0}
          depth={depth}
        />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <TextCell
            value={row.title}
            placeholder="目标描述"
            onChange={(v) => setDraft(item.id, { title: v })}
            onCommit={() => void commitDraft(item)}
            onCancel={() =>
              setDrafts((prev) => {
                const next = { ...prev };
                delete next[item.id];
                return next;
              })
            }
          />
        </td>
        {fields.isVisible('yearCycle') ? (
          <td className="px-1 py-1 align-middle">
            <LifeYearCycleSelect
              unstyled
              pill
              yearCycles={store.yearCycles}
              value={row.yearCycle}
              onChange={(v) => {
                const plan = store.yearPlans.find((p) => p.id === row.yearPlanId);
                const mismatch = Boolean(row.yearPlanId && plan?.yearCycle && plan.yearCycle !== v);
                const body = mismatch ? { yearCycle: v, yearPlanId: '' } : { yearCycle: v };
                if (drafts[item.id]) setDraft(item.id, body);
                else void patch(item.id, body);
              }}
              mutate={yearCycleMutate}
            />
          </td>
        ) : null}
        {fields.isVisible('yearPlanId') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent={Boolean(row.yearPlanId)}
              searchable
              searchPlaceholder="搜索年度计划…"
              ariaLabel="年度计划"
              options={planOpts}
              value={row.yearPlanId || ''}
              onChange={(next) => {
                const picked = applyYearPlanPick(next, row.yearCycle);
                void patch(item.id, picked);
              }}
              triggerClassName={
                row.yearPlanId ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() => {
                const label = yearPlanTitle(store.yearPlans, row.yearPlanId || '');
                return label ? (
                  <span className="inline-flex h-7 max-w-full items-center truncate rounded-md bg-[#e8f0fe] px-2 text-xs font-medium text-[#1f4ec2]">
                    <OverflowHint text={label} className="block min-w-0 truncate" />
                  </span>
                ) : (
                  <OverflowHint
                    text={LIFE_UNSELECTED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                );
              }}
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent={Boolean(row.quarter)}
              searchable
              searchPlaceholder="搜索季度周期…"
              ariaLabel="季度周期"
              options={QUARTER_OPTIONS}
              value={row.quarter}
              onChange={(next) => void patch(item.id, { quarter: next as Quarter })}
              triggerClassName={row.quarter ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER}
              renderTrigger={() =>
                row.quarter ? (
                  <span
                    className={`inline-flex h-7 max-w-full items-center truncate rounded-md px-2 text-xs font-medium ${QUARTER_GROUP_PILL[quarterPillKey(row.quarter)]}`}
                  >
                    <OverflowHint
                      text={QUARTER_LABEL[row.quarter]}
                      className="block min-w-0 truncate"
                    />
                  </span>
                ) : (
                  <OverflowHint
                    text={LIFE_UNSELECTED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                )
              }
            />
          </td>
        ) : null}
        {fields.isVisible('keyResults') ? (
          <td className="px-2 py-1 align-middle">
            <OverflowHint
              text={krs.length ? krs.join(' · ') : '暂无 KR 任务'}
              className="block min-w-0 truncate text-xs text-stone-600"
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressBar value={progress} />
          </td>
        ) : null}
        {fields.isVisible('createdAt') ? (
          <td className="px-1.5 py-1 align-middle">
            <ReadonlyCell text={formatLifeTimestamp(item.createdAt)} muted={!item.createdAt} />
          </td>
        ) : null}
        {fields.isVisible('updatedAt') ? (
          <td className="px-1.5 py-1 align-middle">
            <ReadonlyCell text={formatLifeTimestamp(item.updatedAt)} muted={!item.updatedAt} />
          </td>
        ) : null}
        <td aria-hidden="true" />
        <td className={STICKY_CELL_R}>
          <div className="flex justify-end gap-0.5">
            <LifeExpandButton
              label={`编辑 ${item.title}`}
              disabled={busy}
              onClick={() => setEditItem(item)}
            />
            <LifeDeleteButton
              label={`删除 ${item.title}`}
              disabled={busy}
              onClick={() => setDeleteTargets([item])}
            />
          </div>
        </td>
      </tr>
    );
  }

  if (!gate.ready) return <LifeLoading label="正在读取插件开关" />;
  if (!gate.on) return <LifeNotice>{lifePluginDisabledMessage()}</LifeNotice>;
  if (live === null) return <LifeLoading label="正在连接人生管理服务" />;
  if (!live) {
    return (
      <LifeNotice>
        人生管理需要本地服务，当前未就绪（仅 npm run dev / 本地一体服务可用）。
      </LifeNotice>
    );
  }

  const colCount = visibleCols.length;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3">
        <div className="text-sm text-stone-600">
          共 <span className="font-medium text-stone-800">{store.objectives.length}</span> 条
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索 Objective…"
            className="h-9 w-52 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <SelectDropdown
            flat
            className="w-[148px]"
            ariaLabel="分组方式"
            options={GROUP_BY_OPTIONS}
            value={groupBy}
            onChange={(next) => setGroupBy(next as GroupBy)}
          />
          <LifeFieldConfigButton
            fields={fields.fields}
            isVisible={fields.isVisible}
            onToggle={fields.toggle}
          />
          <button
            type="button"
            disabled={busy || selection.selectedIds.length === 0}
            onClick={() =>
              setDeleteTargets(store.objectives.filter((x) => selection.selected[x.id]))
            }
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy || adding}
            onClick={() => {
              const leafKey = firstLeafNestKey(nestGroups);
              startNewRow(leafKey, presetFromGroupKey(leafKey));
            }}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建目标
          </button>
        </div>
      </div>

      <LifeErrorBar error={error} onDismiss={() => setError('')} />

      <div ref={scrollRef} className="tw-scroll-x min-h-0 flex-1 overflow-auto">
        <table
          className="tw-task-table tw-sticky-table w-full table-fixed text-sm"
          style={cols.tableStyle}
        >
          <colgroup>
            {visibleCols.map((c) => (
              <col
                key={c.key}
                style={
                  c.key === 'select'
                    ? { width: lifeSelectColPx(nestIndent) }
                    : cols.widthOf(c.key)
                      ? { width: cols.widthOf(c.key) }
                      : undefined
                }
              />
            ))}
          </colgroup>
          <thead className="tw-table-head sticky top-0 z-10 text-xs text-stone-500">
            <tr>
              <LifeSelectHead
                checked={selection.allVisibleSelected}
                indeterminate={selection.selectedIds.length > 0 && !selection.allVisibleSelected}
                onChange={() => selection.toggleAllVisible()}
                nested={nestIndent}
              />
              <th
                className={`${STICKY_HEAD_L_RESIZE} text-xs text-stone-500`}
                style={titleStickyStyle}
              >
                目标描述
                <ColumnResizeHandle {...cols.resizeProps('title')} />
              </th>
              {fields.isVisible('yearCycle') ? (
                <th className={LIFE_TH}>
                  年度周期
                  <ColumnResizeHandle {...cols.resizeProps('yearCycle')} />
                </th>
              ) : null}
              {fields.isVisible('yearPlanId') ? (
                <th className={LIFE_TH}>
                  年度计划
                  <ColumnResizeHandle {...cols.resizeProps('yearPlanId')} />
                </th>
              ) : null}
              {fields.isVisible('quarter') ? (
                <th className={LIFE_TH}>
                  季度周期
                  <ColumnResizeHandle {...cols.resizeProps('quarter')} />
                </th>
              ) : null}
              {fields.isVisible('keyResults') ? (
                <th className={LIFE_TH}>
                  关键结果（KR 任务）
                  <ColumnResizeHandle {...cols.resizeProps('keyResults')} />
                </th>
              ) : null}
              {fields.isVisible('progress') ? (
                <th className={LIFE_TH}>
                  完成度
                  <ColumnResizeHandle {...cols.resizeProps('progress')} />
                </th>
              ) : null}
              {fields.isVisible('createdAt') ? (
                <th className={LIFE_TH}>
                  创建日期
                  <ColumnResizeHandle {...cols.resizeProps('createdAt')} />
                </th>
              ) : null}
              {fields.isVisible('updatedAt') ? (
                <th className={LIFE_TH}>
                  修改日期
                  <ColumnResizeHandle {...cols.resizeProps('updatedAt')} />
                </th>
              ) : null}
              <th aria-hidden="true" />
              <th className={STICKY_HEAD_R}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !newRow ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-16 text-center text-sm text-stone-400">
                  {store.objectives.length === 0 ? '还没有 Objective' : '没有匹配的记录'}
                </td>
              </tr>
            ) : filtered.length === 0 && newRow ? (
              renderNewRow()
            ) : groupBy === 'none' ? (
              <>
                {filtered.map((item, i) => renderRow(item, i + 1))}
                {newRow ? (
                  renderNewRow()
                ) : (
                  <LifeAddRecordRow
                    colSpan={colCount}
                    depth={0}
                    selectColPx={lifeSelectColPx(nestIndent)}
                    disabled={busy || adding}
                    onClick={() => startNewRow('all')}
                  />
                )}
              </>
            ) : flatGroups.length === 0 ? (
              newRow ? (
                renderNewRow()
              ) : null
            ) : (
              flatGroups.map((g) => {
                const open = !collapsed[g.key];
                return (
                  <Fragment key={g.key}>
                    <LifeGroupHeader
                      label={g.label}
                      pill={g.pill}
                      count={g.count}
                      open={open}
                      depth={g.depth}
                      kind={g.kind}
                      colSpan={colCount}
                      selectColPx={lifeSelectColPx(nestIndent)}
                      onToggle={() => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                    />
                    {g.items?.map((item, i) => renderRow(item, i + 1, g.depth))}
                    {g.items && g.items.length > 0 ? (
                      newRow?.groupKey === g.key ? (
                        renderNewRow()
                      ) : (
                        <LifeAddRecordRow
                          colSpan={colCount}
                          depth={g.depth}
                          selectColPx={lifeSelectColPx(nestIndent)}
                          disabled={busy || adding}
                          onClick={() => startNewRow(g.key, presetFromGroupKey(g.key))}
                        />
                      )
                    ) : newRow?.groupKey === g.key ? (
                      renderNewRow()
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-stone-100 px-4 py-2.5 text-xs text-stone-500">
        <span>
          显示 {filtered.length} 条
          {selection.selectedIds.length ? ` · 已选 ${selection.selectedIds.length}` : ''}
        </span>
        <span className="ml-auto text-stone-400">
          选「年度计划」后，对应计划的关联 Objective 会自动带出
        </span>
      </div>

      {editItem ? (
        <ObjectiveDrawer
          open
          item={editItem}
          yearCycles={store.yearCycles}
          yearCycleMutate={yearCycleMutate}
          yearPlans={store.yearPlans}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除 Objective'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条目标？`
            : `删除「${deleteTargets?.[0]?.title ?? ''}」？`
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
