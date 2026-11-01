/**
 * OKR 复盘：按 Objective 年度分组（可选）、批量删除、右侧抽屉、行内改。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  QUARTER_LABEL,
  REVIEW_EXPERIENCE_TEMPLATE,
  filterByKeyword,
  objectiveProgress,
  yearCycleLabel,
  type ReviewItem,
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
import SelectDropdown from './SelectDropdown';
import OverflowHint from './OverflowHint';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  LIFE_EMPTY_SELECT_TRIGGER,
  LIFE_TH,
  LIFE_UNLINKED_LABEL,
  LIFE_YEAR_UNSET_LABEL,
  LifeAddRecordRow,
  LifeDeleteButton,
  LifeFieldConfigButton,
  LifeDrawer,
  filterLifeCols,
  LifeErrorBar,
  LifeExpandButton,
  LifeGroupHeader,
  LifeLoading,
  LifeNotice,
  LifeProgressBar,
  LifeSelectCell,
  LifeSelectHead,
  ReadonlyCell,
  TextCell,
  LifeCatalogPill,
  lifeCatalogCellClass,
  lifePluginDisabledMessage,
  objectiveById,
  sortByCreated,
  sortByUpdated,
  useLifeEnumPref,
  useLifeKeyword,
  useLifePlugin,
  useLifeFieldVisibility,
  useLifeSelection,
  useLifeStore,
  LIFE_NEW_ROW_TITLE_INPUT,
  useLifeInlineNewRow,
  type LifeGroup,
} from './LifeShared';

const COLS = [
  { key: 'select', width: 36, min: 32 },
  { key: 'title', width: 200, min: 140 },
  { key: 'objective', width: 180, min: 120 },
  { key: 'year', width: 88, min: 72 },
  { key: 'quarter', width: 120, min: 88 },
  { key: 'progress', width: 120, min: 96 },
  { key: 'score', width: 72, min: 56 },
  { key: 'experience', width: 220, min: 140 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'objective', label: 'Objective' },
  { key: 'year', label: '年度周期' },
  { key: 'quarter', label: '季度周期' },
  { key: 'progress', label: '完成度' },
  { key: 'score', label: '评分' },
  { key: 'experience', label: '经验收获' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.reviews.fields';

const KEYWORD_PREF = 'life.reviews.search';
const GROUP_PREF = 'life.reviews.group';
const GROUP_VALUES = ['year', 'none'] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'year', label: '按年度周期分组' },
];

type Draft = {
  title: string;
  objectiveId: string;
  score: number;
  experience: string;
};

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    objectiveId: preset?.objectiveId ?? '',
    score: preset?.score ?? 0,
    experience: preset?.experience ?? REVIEW_EXPERIENCE_TEMPLATE,
  };
}

type NewRow = Draft & {
  groupKey: string;
  baseObjectiveId: string;
  baseScore: number;
  baseExperience: string;
};

/** 标题为空且刚选中 Objective 时，用「目标名 复盘」作建议标题 */
function suggestReviewTitle(
  currentTitle: string,
  objectiveId: string,
  objectives: { id: string; title: string }[],
): string | undefined {
  if (currentTitle.trim() || !objectiveId) return undefined;
  const t = objectives.find((o) => o.id === objectiveId)?.title.trim();
  return t ? `${t} 复盘` : undefined;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
}

function reviewYearLabel(
  store: ReturnType<typeof useLifeStore>['store'],
  objective: ReturnType<typeof objectiveById>,
): string {
  const id = objective?.yearCycle?.trim() || '';
  if (!id) return '—';
  return yearCycleLabel(store.yearCycles, id) || '—';
}

function ReviewDrawer(props: {
  open: boolean;
  item: ReviewItem;
  objectiveOptions: { value: string; label: string }[];
  store: ReturnType<typeof useLifeStore>['store'];
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const { open, item, objectiveOptions, store, isVisible, onClose, onSave } = props;
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft({
      title: item.title,
      objectiveId: item.objectiveId,
      score: item.score,
      experience: item.experience,
    });
  }, [open, item]);

  const objective = objectiveById(store, draft.objectiveId);
  const progress = objective ? objectiveProgress(objective.id, store.krTasks, store.krTodos) : 0;

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写复盘标题');
      return;
    }
    setBusy(true);
    try {
      await onSave(
        {
          ...draft,
          title,
          score: clampScore(draft.score),
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

  return (
    <LifeDrawer
      open={open}
      title="复盘详情"
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
      <FieldRow icon={<IconText />} label="标题">
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
      {isVisible('objective') ? (
        <FieldRow icon={<IconTask />} label="Objective">
          <SelectDropdown
            flat
            searchable
            searchPlaceholder="搜索 Objective…"
            ariaLabel="Objective"
            options={objectiveOptions}
            value={draft.objectiveId}
            onChange={(next) => {
              const suggested = suggestReviewTitle(draft.title, next, store.objectives);
              setDraft({
                ...draft,
                objectiveId: next,
                ...(suggested ? { title: suggested } : null),
              });
            }}
            className="w-full"
            triggerClassName={draft.objectiveId ? undefined : LIFE_EMPTY_SELECT_TRIGGER}
            renderTrigger={() =>
              draft.objectiveId && objective ? (
                <OverflowHint
                  text={objective.title}
                  className="block min-w-0 truncate text-stone-800"
                />
              ) : (
                <OverflowHint
                  text={LIFE_UNLINKED_LABEL}
                  className="block min-w-0 truncate text-stone-400"
                />
              )
            }
          />
        </FieldRow>
      ) : null}
      {isVisible('year') ? (
        <FieldRow icon={<IconTask />} label="年度周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {objective ? reviewYearLabel(store, objective) : '跟随所属目标'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('quarter') ? (
        <FieldRow icon={<IconTask />} label="季度周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {objective
              ? objective.quarter
                ? QUARTER_LABEL[objective.quarter]
                : '—'
              : '跟随所属目标'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('progress') ? (
        <FieldRow icon={<IconTask />} label="完成度">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {objective ? `${progress}%（按关联 KR 任务完成度）` : '关联 Objective 后自动计算'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('score') ? (
        <FieldRow icon={<IconText />} label="评分">
          <input
            type="number"
            min={0}
            max={100}
            value={draft.score}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                setDraft({ ...draft, score: 0 });
                return;
              }
              const n = Number(raw);
              if (!Number.isFinite(n)) return;
              setDraft({ ...draft, score: clampScore(n) });
            }}
            className={DRAWER_INPUT}
          />
        </FieldRow>
      ) : null}
      {isVisible('experience') ? (
        <FieldRow icon={<IconText />} label="经验收获">
          <textarea
            value={draft.experience}
            onChange={(e) => setDraft({ ...draft, experience: e.target.value })}
            placeholder={REVIEW_EXPERIENCE_TEMPLATE}
            rows={4}
            className="w-full rounded-md border border-transparent px-2 py-1.5 text-sm text-stone-800 outline-none transition-colors hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
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

export default function LifeReviewsBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const titleStickyStyle = lifeStickyTitleStyle() as CSSProperties;
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [deleteTargets, setDeleteTargets] = useState<ReviewItem[] | null>(null);
  const [editItem, setEditItem] = useState<ReviewItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<ReviewItem>>>({});
  const [newRow, setNewRow] = useState<NewRow | null>(null);

  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const visibleCols = useMemo(() => filterLifeCols(COLS, fields.isVisible), [fields.isVisible]);
  const cols = useColumnWidths('life.reviews.cols.v12', visibleCols);
  const scrollRef = useScrollEdges('life.reviews');

  const objectiveOptions = useMemo(
    () => [
      { value: '', label: LIFE_UNLINKED_LABEL },
      ...sortByUpdated(store.objectives).map((o) => ({ value: o.id, label: o.title })),
    ],
    [store.objectives],
  );

  const filtered = useMemo(
    () => sortByCreated(filterByKeyword(store.reviews, keyword)),
    [store.reviews, keyword],
  );

  const groups = useMemo<LifeGroup<ReviewItem>[]>(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '全部复盘', pill: 'bg-stone-500 text-white', items: filtered }];
    }
    const yearIdOf = (r: ReviewItem) => {
      const o = objectiveById(store, r.objectiveId);
      return o?.yearCycle?.trim() || '';
    };
    const yearLabelOf = (id: string) =>
      id ? yearCycleLabel(store.yearCycles, id) || id : LIFE_YEAR_UNSET_LABEL;
    const yearIds = [...new Set(filtered.map(yearIdOf))];
    yearIds.sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return yearLabelOf(b).localeCompare(yearLabelOf(a), undefined, { numeric: true });
    });
    const result: LifeGroup<ReviewItem>[] = yearIds.filter(Boolean).map((id) => ({
      key: `year:${id}`,
      label: yearLabelOf(id),
      pill: lifeCatalogCellClass(id),
      items: filtered.filter((r) => yearIdOf(r) === id),
    }));
    const unset = filtered.filter((r) => {
      const o = objectiveById(store, r.objectiveId);
      return !o?.yearCycle?.trim();
    });
    if (unset.length) {
      result.push({
        key: 'year:unset',
        label: LIFE_YEAR_UNSET_LABEL,
        pill: lifeCatalogCellClass(''),
        items: unset,
      });
    }
    return result;
  }, [groupBy, filtered, store, store.yearCycles]);

  // 有数据时藏空组；全部为空时留占位，否则「+ 新建复盘」的 draft 无处渲染
  const visibleGroups = useMemo(() => {
    if (groupBy === 'none') return groups;
    const nonempty = groups.filter((g) => g.items.length > 0);
    if (nonempty.length > 0) return nonempty;
    return [
      {
        key: 'year:unset',
        label: LIFE_YEAR_UNSET_LABEL,
        pill: lifeCatalogCellClass(''),
        items: [] as ReviewItem[],
      },
    ];
  }, [groupBy, groups]);
  const visibleIds = useMemo(
    () => visibleGroups.flatMap((g) => g.items.map((x) => x.id)),
    [visibleGroups],
  );
  const selection = useLifeSelection(visibleIds);

  const { submit: submitNewRow } = useLifeInlineNewRow({
    row: newRow,
    setRow: setNewRow,
    submitting: adding,
    isPristine: (row) =>
      !row.title.trim() &&
      row.objectiveId === row.baseObjectiveId &&
      row.score === row.baseScore &&
      row.experience === row.baseExperience,
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('reviews', [
          {
            title: row.title,
            objectiveId: row.objectiveId,
            score: clampScore(row.score),
            experience: row.experience,
          },
        ]);
        setNewRow(null);
        showToast('已新增复盘', 'success');
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
    const objectiveId = preset?.objectiveId ?? '';
    const score = preset?.score ?? 0;
    const experience = preset?.experience ?? REVIEW_EXPERIENCE_TEMPLATE;
    setNewRow({
      groupKey,
      title: '',
      objectiveId,
      score,
      experience,
      baseObjectiveId: objectiveId,
      baseScore: score,
      baseExperience: experience,
    });
    setCollapsed((prev) => ({ ...prev, [groupKey]: false }));
  }

  async function patch(id: string, patchBody: Record<string, unknown>) {
    try {
      await updateItem('reviews', id, patchBody);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** 只提交评分，保留同行其它未提交草稿（如标题 / 经验收获） */
  async function patchScore(id: string, score: number) {
    try {
      await updateItem('reviews', id, { score });
      setDrafts((prev) => {
        const d = prev[id];
        if (!d || !('score' in d)) return prev;
        const rest = { ...d };
        delete rest.score;
        if (Object.keys(rest).length === 0) {
          const next = { ...prev };
          delete next[id];
          return next;
        }
        return { ...prev, [id]: rest };
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  function draftOf(item: ReviewItem): ReviewItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patch: Partial<ReviewItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function commitDraft(item: ReviewItem) {
    const d = drafts[item.id];
    if (!d) return;
    const title = (d.title ?? item.title).trim();
    if (!title) {
      setError('标题不能为空');
      return;
    }
    await patch(item.id, { ...d, title });
  }

  async function saveFromDrawer(draft: Draft, id: string) {
    await updateItem('reviews', id, draft);
    showToast('已保存', 'success');
  }

  function renderNewRow() {
    if (!newRow) return null;
    const objective = objectiveById(store, newRow.objectiveId);
    const progress = objective ? objectiveProgress(objective.id, store.krTasks, store.krTodos) : 0;
    return (
      <tr className="tw-new-row">
        <td className="px-2 py-1 align-middle" />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <input
            autoFocus
            disabled={adding}
            value={newRow.title}
            placeholder="输入复盘名称，回车或点空白处保存"
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
        {fields.isVisible('objective') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              searchable
              searchPlaceholder="搜索 Objective…"
              ariaLabel="Objective"
              menuMinWidth={220}
              options={objectiveOptions}
              value={newRow.objectiveId}
              onChange={(next) =>
                setNewRow((prev) => {
                  if (!prev) return prev;
                  const suggested = suggestReviewTitle(prev.title, next, store.objectives);
                  return {
                    ...prev,
                    objectiveId: next,
                    ...(suggested ? { title: suggested } : null),
                  };
                })
              }
              triggerClassName={
                objective
                  ? 'h-8 w-full rounded-md px-1.5 text-sm hover:border-stone-200'
                  : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() =>
                objective ? (
                  <OverflowHint
                    text={objective.title}
                    className="block min-w-0 truncate text-stone-800"
                  />
                ) : (
                  <OverflowHint
                    text={LIFE_UNLINKED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                )
              }
            />
          </td>
        ) : null}
        {fields.isVisible('year') ? (
          <td className="px-1 py-1 align-middle">
            <LifeCatalogPill
              id={objective?.yearCycle?.trim() || ''}
              label={reviewYearLabel(store, objective)}
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <ReadonlyCell
              text={objective?.quarter ? QUARTER_LABEL[objective.quarter] : '—'}
              muted={!objective?.quarter}
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            {objective ? <LifeProgressBar value={progress} /> : <ReadonlyCell text="—" muted />}
          </td>
        ) : null}
        {fields.isVisible('score') ? (
          <td className="px-1 py-1 align-middle">
            <input
              type="number"
              min={0}
              max={100}
              disabled={adding}
              value={newRow.score}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setNewRow((prev) => (prev ? { ...prev, score: 0 } : prev));
                  return;
                }
                const n = Number(raw);
                if (!Number.isFinite(n)) return;
                setNewRow((prev) => (prev ? { ...prev, score: clampScore(n) } : prev));
              }}
              className="h-8 w-full rounded-md border border-transparent px-1.5 text-sm tabular-nums hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
            />
          </td>
        ) : null}
        {fields.isVisible('experience') ? (
          <td className="px-1 py-1 align-middle">
            <TextCell
              value={newRow.experience}
              placeholder="经验收获"
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, experience: v } : prev))}
              onCommit={() => undefined}
              onCancel={() => undefined}
            />
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

  async function confirmDelete() {
    const targets = deleteTargets;
    if (!targets?.length) return;
    setDeleteTargets(null);
    setBusy(true);
    try {
      await deleteItems(
        'reviews',
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

  function renderRow(item: ReviewItem, index: number) {
    const row = draftOf(item);
    const objective = objectiveById(store, row.objectiveId);
    const progress = objective ? objectiveProgress(objective.id, store.krTasks, store.krTodos) : 0;
    return (
      <tr key={item.id} className="group/row tw-life-group-body hover:bg-[#f7f8fa]">
        <LifeSelectCell
          checked={Boolean(selection.selected[item.id])}
          onChange={() => selection.toggle(item.id)}
          label={`选择 ${item.title}`}
          index={index}
          selecting={selection.selectedIds.length > 0}
        />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <TextCell
            value={row.title}
            placeholder="标题"
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
        {fields.isVisible('objective') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              searchable
              searchPlaceholder="搜索 Objective…"
              ariaLabel="Objective"
              menuMinWidth={220}
              options={objectiveOptions}
              value={row.objectiveId}
              onChange={(next) => {
                const body: Record<string, unknown> = { objectiveId: next };
                const suggested = suggestReviewTitle(row.title, next, store.objectives);
                if (suggested) body.title = suggested;
                void patch(item.id, body);
              }}
              triggerClassName={
                objective
                  ? 'h-8 w-full rounded-md px-1.5 text-sm hover:border-stone-200'
                  : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() =>
                objective ? (
                  <OverflowHint
                    text={objective.title}
                    className="block min-w-0 truncate text-stone-800"
                  />
                ) : (
                  <OverflowHint
                    text={LIFE_UNLINKED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                )
              }
            />
          </td>
        ) : null}
        {fields.isVisible('year') ? (
          <td className="px-1 py-1 align-middle">
            <LifeCatalogPill
              id={objective?.yearCycle?.trim() || ''}
              label={reviewYearLabel(store, objective)}
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <ReadonlyCell
              text={objective?.quarter ? QUARTER_LABEL[objective.quarter] : '—'}
              muted={!objective?.quarter}
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            {objective ? <LifeProgressBar value={progress} /> : <ReadonlyCell text="—" muted />}
          </td>
        ) : null}
        {fields.isVisible('score') ? (
          <td className="px-1 py-1 align-middle">
            <input
              type="number"
              min={0}
              max={100}
              value={row.score}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setDraft(item.id, { score: 0 });
                  return;
                }
                const n = Number(raw);
                if (!Number.isFinite(n)) return;
                setDraft(item.id, { score: clampScore(n) });
              }}
              onBlur={(e) => {
                const n = clampScore(Number(e.currentTarget.value) || 0);
                if (n !== item.score) void patchScore(item.id, n);
                else if (drafts[item.id] && 'score' in drafts[item.id]) {
                  setDrafts((prev) => {
                    const d = prev[item.id];
                    if (!d || !('score' in d)) return prev;
                    const rest = { ...d };
                    delete rest.score;
                    if (Object.keys(rest).length === 0) {
                      const next = { ...prev };
                      delete next[item.id];
                      return next;
                    }
                    return { ...prev, [item.id]: rest };
                  });
                }
              }}
              className="h-8 w-full rounded-md border border-transparent px-1.5 text-sm tabular-nums hover:border-stone-200 focus:border-[#3370ff] focus:bg-white"
            />
          </td>
        ) : null}
        {fields.isVisible('experience') ? (
          <td className="px-1 py-1 align-middle">
            <TextCell
              value={row.experience}
              placeholder="经验收获"
              onChange={(v) => setDraft(item.id, { experience: v })}
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
          共 <span className="font-medium text-stone-800">{store.reviews.length}</span> 条
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索复盘…"
            className="h-9 w-52 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <SelectDropdown
            flat
            className="w-[132px]"
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
            onClick={() => setDeleteTargets(store.reviews.filter((x) => selection.selected[x.id]))}
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy || adding}
            onClick={() => {
              const g = visibleGroups[0] ?? groups[0];
              startNewRow(g?.key ?? 'all');
            }}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建复盘
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
                    ? { width: lifeSelectColPx(false) }
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
              />
              <th
                className={`${STICKY_HEAD_L_RESIZE} text-xs text-stone-500`}
                style={titleStickyStyle}
              >
                标题
                <ColumnResizeHandle {...cols.resizeProps('title')} />
              </th>
              {fields.isVisible('objective') ? (
                <th className={LIFE_TH}>
                  Objective
                  <ColumnResizeHandle {...cols.resizeProps('objective')} />
                </th>
              ) : null}
              {fields.isVisible('year') ? (
                <th className={LIFE_TH}>
                  年度周期
                  <ColumnResizeHandle {...cols.resizeProps('year')} />
                </th>
              ) : null}
              {fields.isVisible('quarter') ? (
                <th className={LIFE_TH}>
                  季度周期
                  <ColumnResizeHandle {...cols.resizeProps('quarter')} />
                </th>
              ) : null}
              {fields.isVisible('progress') ? (
                <th className={LIFE_TH}>
                  完成度
                  <ColumnResizeHandle {...cols.resizeProps('progress')} />
                </th>
              ) : null}
              {fields.isVisible('score') ? (
                <th className={LIFE_TH}>
                  评分
                  <ColumnResizeHandle {...cols.resizeProps('score')} />
                </th>
              ) : null}
              {fields.isVisible('experience') ? (
                <th className={LIFE_TH}>
                  经验收获
                  <ColumnResizeHandle {...cols.resizeProps('experience')} />
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
                  {store.reviews.length === 0 ? '还没有 OKR 复盘' : '没有匹配的记录'}
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
                    disabled={busy || adding}
                    onClick={() => startNewRow('all')}
                  />
                )}
              </>
            ) : visibleGroups.length === 0 ? (
              newRow ? (
                renderNewRow()
              ) : null
            ) : (
              visibleGroups.map((g) => {
                const open = !collapsed[g.key];
                return (
                  <Fragment key={g.key}>
                    <LifeGroupHeader
                      label={g.label}
                      pill={g.pill}
                      count={g.items.length}
                      open={open}
                      kind="tag"
                      colSpan={colCount}
                      onToggle={() => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                    />
                    {open ? (
                      <>
                        {g.items.map((item, i) => renderRow(item, i + 1))}
                        {newRow?.groupKey === g.key ? (
                          renderNewRow()
                        ) : filtered.length > 0 ? (
                          <LifeAddRecordRow
                            colSpan={colCount}
                            disabled={busy || adding}
                            onClick={() => startNewRow(g.key)}
                          />
                        ) : null}
                      </>
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
        <span className="ml-auto text-stone-400">新建时经验收获带三段提纲，可按需改写</span>
      </div>

      {editItem ? (
        <ReviewDrawer
          open
          item={editItem}
          objectiveOptions={objectiveOptions}
          store={store}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除复盘'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条复盘？`
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
