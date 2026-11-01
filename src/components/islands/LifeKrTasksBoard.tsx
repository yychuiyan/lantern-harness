/**
 * KR 任务：分组、多选批量删除、行内新增、抽屉仅编辑、行内改；待办汇总只读。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  KR_TASK_STATUSES,
  KR_TASK_STATUS_LABEL,
  LIFE_PRIORITIES,
  LIFE_PRIORITY_LABEL,
  QUARTER_LABEL,
  filterByKeyword,
  krTaskTodoStats,
  planTypeLabel,
  sortPlanTypes,
  yearCycleLabel,
  type KrTaskItem,
  type KrTaskStatus,
  type LifePriority,
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
import {
  DRAWER_INPUT,
  DrawerField as FieldRow,
  DrawerSelect,
  IconStatus,
  IconTask,
  IconText,
} from './DrawerField';
import LifePlanTypeSelect from './LifePlanTypeSelect';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  KR_TASK_STATUS_CELL,
  KR_TASK_STATUS_DOT,
  LIFE_EMPTY_SELECT_TRIGGER,
  LIFE_FILLED_PILL_TRIGGER,
  LIFE_PRIORITY_CELL,
  LIFE_PRIORITY_DOT,
  LIFE_PRIORITY_PILL,
  LIFE_UNLINKED_LABEL,
  LIFE_UNSELECTED_LABEL,
  LIFE_YEAR_UNSET_LABEL,
  LIFE_NEW_ROW_TITLE_INPUT,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  LIFE_TH,
  LIFE_TH_CLUSTER,
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
  NoteCell,
  ReadonlyCell,
  TextCell,
  LifeCatalogPill,
  collectNestItemIds,
  flattenLifeNestGroups,
  lifeCatalogCellClass,
  lifePluginDisabledMessage,
  objectiveById,
  sortByStatusThenCreated,
  sortByUpdated,
  useLifeEnumPref,
  useLifeInlineNewRow,
  useLifeKeyword,
  useLifePlugin,
  useLifeFieldVisibility,
  useLifeSelection,
  useLifeStore,
  type LifeNestGroup,
} from './LifeShared';

const COLS = [
  { key: 'select', width: 36, min: 32 },
  { key: 'title', width: 220, min: 160 },
  { key: 'status', width: 104, min: 76 },
  { key: 'priority', width: 104, min: 84 },
  { key: 'planType', width: 112, min: 88 },
  { key: 'objective', width: 160, min: 100 },
  { key: 'year', width: 88, min: 72 },
  { key: 'quarter', width: 120, min: 88 },
  { key: 'todoList', width: 180, min: 120 },
  { key: 'todos', width: 72, min: 56 },
  { key: 'summary', width: 160, min: 100 },
  { key: 'progress', width: 120, min: 96 },
  { key: 'note', width: 120, min: 88 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'status', label: '状态' },
  { key: 'priority', label: '重要紧急程度' },
  { key: 'planType', label: '计划类型' },
  { key: 'objective', label: '所属目标' },
  { key: 'year', label: '年度周期' },
  { key: 'quarter', label: '季度周期' },
  { key: 'todoList', label: '待办列表' },
  { key: 'todos', label: '待办数' },
  { key: 'summary', label: '待办摘要' },
  { key: 'progress', label: '完成度' },
  { key: 'note', label: '备注' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.kr-tasks.fields';

const KEYWORD_PREF = 'life.kr-tasks.search';
const GROUP_PREF = 'life.kr-tasks.group';
const STATUS_FILTER_PREF = 'life.kr-tasks.status';
const GROUP_VALUES = [
  'yearStatus',
  'yearPriority',
  'yearPlanType',
  'status',
  'priority',
  'none',
] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const STATUS_OPTIONS = KR_TASK_STATUSES.map((s) => ({ value: s, label: KR_TASK_STATUS_LABEL[s] }));
/** 分组头用浅底胶囊（对齐参考稿） */
const STATUS_PILL = KR_TASK_STATUS_CELL;

const PRIORITY_GROUP_ORDER: readonly LifePriority[] = [
  'urgent_important',
  'urgent',
  'important',
  'normal',
  '',
];

const PRIORITY_PILL = LIFE_PRIORITY_CELL;

const PRIORITY_OPTIONS: { value: LifePriority; label: string }[] = LIFE_PRIORITIES.filter(
  (p) => p !== '',
).map((p) => ({
  value: p,
  label: LIFE_PRIORITY_LABEL[p],
}));

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'yearStatus', label: '按年度 → 状态' },
  { value: 'yearPriority', label: '按年度 → 重要紧急程度' },
  { value: 'yearPlanType', label: '按年度 → 计划类型' },
  { value: 'status', label: '按状态分组' },
  { value: 'priority', label: '按重要紧急程度分组' },
];

type StatusFilter = KrTaskStatus | 'all';
const STATUS_FILTER_VALUES = ['all', ...KR_TASK_STATUSES] as const;
const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  ...KR_TASK_STATUSES.map((s) => ({ value: s, label: KR_TASK_STATUS_LABEL[s] })),
];

type Draft = {
  title: string;
  status: KrTaskStatus;
  priority: LifePriority;
  planType: string;
  objectiveId: string;
  note: string;
};

type PlanTypeMutate = {
  createItems: ReturnType<typeof useLifeStore>['createItems'];
  updateItem: ReturnType<typeof useLifeStore>['updateItem'];
  deleteItems: ReturnType<typeof useLifeStore>['deleteItems'];
};

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    status: preset?.status ?? 'pool',
    priority: preset?.priority ?? '',
    planType: preset?.planType ?? '',
    objectiveId: preset?.objectiveId ?? '',
    note: preset?.note ?? '',
  };
}

function presetFromGroupKey(key: string): Partial<Draft> {
  const out: Partial<Draft> = {};
  const status = /(?:^|\|)status:([^|]+)/.exec(key)?.[1];
  if (status && (KR_TASK_STATUSES as readonly string[]).includes(status)) {
    out.status = status as KrTaskStatus;
  }
  const priority = /(?:^|\|)priority:([^|]+)/.exec(key)?.[1];
  if (priority === 'unset') out.priority = '';
  else if (priority && (PRIORITY_GROUP_ORDER as readonly string[]).includes(priority)) {
    out.priority = priority as LifePriority;
  }
  const planType = /(?:^|\|)planType:([^|]+)/.exec(key)?.[1];
  if (planType === 'unset') out.planType = '';
  else if (planType) out.planType = planType;
  return out;
}

type NewRow = Draft & { groupKey: string; base: Draft };

function KrTaskDrawer(props: {
  open: boolean;
  item: KrTaskItem;
  objectiveOptions: { value: string; label: string }[];
  store: ReturnType<typeof useLifeStore>['store'];
  mutate: PlanTypeMutate;
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const { open, item, objectiveOptions, store, mutate, isVisible, onClose, onSave } = props;
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft({
      title: item.title,
      status: item.status,
      priority: item.priority,
      planType: item.planType || '',
      objectiveId: item.objectiveId,
      note: item.note,
    });
  }, [open, item, store.planTypes]);

  const objective = objectiveById(store, draft.objectiveId);
  const stats = krTaskTodoStats(item.id, store.krTodos);

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写任务描述');
      return;
    }
    setBusy(true);
    try {
      await onSave({ ...draft, title }, item.id);
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
      title="任务详情"
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
      <FieldRow icon={<IconText />} label="任务描述">
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
      {isVisible('status') ? (
        <FieldRow icon={<IconStatus />} label="任务状态">
          <DrawerSelect
            ariaLabel="任务状态"
            options={STATUS_OPTIONS}
            value={draft.status}
            onChange={(next) => setDraft({ ...draft, status: next as KrTaskStatus })}
            label={KR_TASK_STATUS_LABEL[draft.status]}
            optionDotClassName={(v) => KR_TASK_STATUS_DOT[v as KrTaskStatus]}
          />
        </FieldRow>
      ) : null}
      {isVisible('priority') ? (
        <FieldRow icon={<IconStatus />} label="重要紧急程度">
          <DrawerSelect
            ariaLabel="重要紧急程度"
            options={PRIORITY_OPTIONS}
            value={draft.priority}
            onChange={(next) => setDraft({ ...draft, priority: next as LifePriority })}
            label={draft.priority ? LIFE_PRIORITY_LABEL[draft.priority] : LIFE_UNSELECTED_LABEL}
            optionDotClassName={(v) => LIFE_PRIORITY_DOT[v as LifePriority]}
          />
        </FieldRow>
      ) : null}
      {isVisible('planType') ? (
        <FieldRow icon={<IconTask />} label="任务类型">
          <LifePlanTypeSelect
            flat
            className="w-full"
            ariaLabel="任务类型"
            planTypes={store.planTypes}
            value={draft.planType}
            onChange={(next) => setDraft({ ...draft, planType: next })}
            mutate={mutate}
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
      {isVisible('objective') ? (
        <FieldRow icon={<IconTask />} label="所属目标">
          <SelectDropdown
            flat
            searchable
            searchPlaceholder="搜索 Objective…"
            ariaLabel="所属目标"
            options={objectiveOptions}
            value={draft.objectiveId}
            onChange={(next) => setDraft({ ...draft, objectiveId: next })}
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
            {objective?.yearCycle?.trim()
              ? yearCycleLabel(store.yearCycles, objective.yearCycle) || '—'
              : '—'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('quarter') ? (
        <FieldRow icon={<IconTask />} label="季度周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {objective?.quarter ? QUARTER_LABEL[objective.quarter] : '—'}
          </div>
        </FieldRow>
      ) : null}
      {stats &&
      (isVisible('todoList') ||
        isVisible('todos') ||
        isVisible('summary') ||
        isVisible('progress')) ? (
        <FieldRow icon={<IconTask />} label="待办汇总">
          <div className="space-y-1 px-2 py-1.5 text-sm text-stone-500">
            <div>
              {stats.count} 条 · 进度 {stats.progress}%
            </div>
            <div className="text-xs">{stats.summary || '—'}</div>
          </div>
        </FieldRow>
      ) : null}
      {isVisible('note') ? (
        <FieldRow icon={<IconText />} label="备注">
          <textarea
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            rows={3}
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

export default function LifeKrTasksBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const planTypeMutate = useMemo(
    () => ({ createItems, updateItem, deleteItems }),
    [createItems, updateItem, deleteItems],
  );
  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const nestIndent =
    groupBy === 'yearStatus' || groupBy === 'yearPriority' || groupBy === 'yearPlanType';
  const titleStickyStyle = lifeStickyTitleStyle(nestIndent) as CSSProperties;
  const visibleCols = useMemo(() => {
    const w = lifeSelectColPx(nestIndent);
    return filterLifeCols(COLS, fields.isVisible).map((c) =>
      c.key === 'select' ? { ...c, width: w, min: w } : c,
    );
  }, [fields.isVisible, nestIndent]);
  const [statusFilter, setStatusFilter] = useLifeEnumPref(
    STATUS_FILTER_PREF,
    STATUS_FILTER_VALUES,
    'all',
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [deleteTargets, setDeleteTargets] = useState<KrTaskItem[] | null>(null);
  const [editItem, setEditItem] = useState<KrTaskItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<NewRow | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<KrTaskItem>>>({});

  const cols = useColumnWidths('life.kr-tasks.cols.v13', visibleCols);

  const objectiveYearText = (objective: ReturnType<typeof objectiveById>) => {
    const id = objective?.yearCycle?.trim() || '';
    if (!id) return '—';
    return yearCycleLabel(store.yearCycles, id) || '—';
  };

  const { submit: submitNewRow } = useLifeInlineNewRow({
    row: newRow,
    setRow: setNewRow,
    submitting: adding,
    isPristine: (row) => {
      const b = row.base;
      return (
        !row.title.trim() &&
        row.status === b.status &&
        row.priority === b.priority &&
        row.planType === b.planType &&
        row.objectiveId === b.objectiveId &&
        row.note === b.note
      );
    },
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('krTasks', [
          {
            title: row.title,
            status: row.status,
            priority: row.priority,
            planType: row.planType,
            objectiveId: row.objectiveId,
            note: row.note,
          },
        ]);
        setNewRow(null);
        showToast('已新增 KR 任务', 'success');
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
    const base = emptyDraft(preset);
    setNewRow({ groupKey, ...base, base });
    setCollapsed((prev) => ({ ...prev, [groupKey]: false }));
  }
  const scrollRef = useScrollEdges('life.kr-tasks');

  const objectiveOptions = useMemo(
    () => [
      { value: '', label: LIFE_UNLINKED_LABEL },
      ...sortByUpdated(store.objectives).map((o) => ({ value: o.id, label: o.title })),
    ],
    [store.objectives],
  );

  const filtered = useMemo(() => {
    let list = filterByKeyword(store.krTasks, keyword);
    if (statusFilter !== 'all') list = list.filter((x) => x.status === statusFilter);
    return sortByStatusThenCreated(list, KR_TASK_STATUSES);
  }, [store.krTasks, keyword, statusFilter]);

  const nestGroups = useMemo<LifeNestGroup<KrTaskItem>[]>(() => {
    const yearIdOf = (item: KrTaskItem) => {
      const obj = objectiveById(store, item.objectiveId);
      return obj?.yearCycle?.trim() || '';
    };
    const yearLabelOf = (id: string) =>
      id ? yearCycleLabel(store.yearCycles, id) || LIFE_YEAR_UNSET_LABEL : LIFE_YEAR_UNSET_LABEL;

    if (groupBy === 'none') {
      return [{ key: 'all', label: '全部任务', pill: 'bg-stone-500 text-white', items: filtered }];
    }
    if (groupBy === 'status') {
      return KR_TASK_STATUSES.map((s) => ({
        key: `status:${s}`,
        label: KR_TASK_STATUS_LABEL[s],
        pill: STATUS_PILL[s],
        items: filtered.filter((x) => x.status === s),
      }));
    }
    if (groupBy === 'priority') {
      return PRIORITY_GROUP_ORDER.map((p) => ({
        key: `priority:${p || 'unset'}`,
        label: p ? LIFE_PRIORITY_LABEL[p] : LIFE_UNSELECTED_LABEL,
        pill: PRIORITY_PILL[p],
        items: filtered.filter((x) => x.priority === p),
      }));
    }

    const yearIds = [...new Set(filtered.map(yearIdOf))];
    yearIds.sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return yearLabelOf(b).localeCompare(yearLabelOf(a), undefined, { numeric: true });
    });

    // 无数据时 flatten 会跳过空父级，导致「+ 新建任务」的 draft 无处渲染
    if (yearIds.length === 0) {
      return [
        {
          key: 'year:',
          label: LIFE_YEAR_UNSET_LABEL,
          pill: lifeCatalogCellClass(''),
          items: [] as KrTaskItem[],
        },
      ];
    }

    if (groupBy === 'yearStatus') {
      return yearIds
        .map((id) => {
          const inYear = filtered.filter((x) => yearIdOf(x) === id);
          const label = yearLabelOf(id);
          const children = KR_TASK_STATUSES.map((s) => ({
            key: `year:${id}|status:${s}`,
            label: KR_TASK_STATUS_LABEL[s],
            pill: STATUS_PILL[s],
            items: inYear.filter((x) => x.status === s),
          })).filter((c) => c.items.length > 0);
          return {
            key: `year:${id}`,
            label,
            pill: lifeCatalogCellClass(id),
            children,
          };
        })
        .filter((y) => (y.children?.length ?? 0) > 0);
    }

    if (groupBy === 'yearPlanType') {
      const catalogIds = sortPlanTypes(store.planTypes).map((t) => t.id);
      const known = new Set(catalogIds);
      // 目录外残留 id 仍单独成组，避免任务「消失」
      const orphanIds = [
        ...new Set(filtered.map((x) => x.planType || '').filter((id) => id && !known.has(id))),
      ].sort((a, b) =>
        (planTypeLabel(store.planTypes, a) || a).localeCompare(
          planTypeLabel(store.planTypes, b) || b,
          'zh',
        ),
      );
      const typeIds = [...catalogIds, ...orphanIds, ''];
      return yearIds
        .map((id) => {
          const inYear = filtered.filter((x) => yearIdOf(x) === id);
          const label = yearLabelOf(id);
          const children = typeIds
            .map((pt) => ({
              key: `year:${id}|planType:${pt || 'unset'}`,
              label: pt ? planTypeLabel(store.planTypes, pt) || pt : LIFE_UNSELECTED_LABEL,
              pill: lifeCatalogCellClass(pt),
              items: inYear.filter((x) => (x.planType || '') === pt),
            }))
            .filter((c) => c.items.length > 0);
          return {
            key: `year:${id}`,
            label,
            pill: lifeCatalogCellClass(id),
            children,
          };
        })
        .filter((y) => (y.children?.length ?? 0) > 0);
    }

    // 年度 → 紧急程度：同样只留有数据的子组
    return yearIds
      .map((id) => {
        const inYear = filtered.filter((x) => yearIdOf(x) === id);
        const label = yearLabelOf(id);
        const children = PRIORITY_GROUP_ORDER.map((p) => ({
          key: `year:${id}|priority:${p || 'unset'}`,
          label: p ? LIFE_PRIORITY_LABEL[p] : LIFE_UNSELECTED_LABEL,
          pill: PRIORITY_PILL[p],
          items: inYear.filter((x) => x.priority === p),
        })).filter((c) => c.items.length > 0);
        return {
          key: `year:${id}`,
          label,
          pill: lifeCatalogCellClass(id),
          children,
        };
      })
      .filter((y) => (y.children?.length ?? 0) > 0);
  }, [groupBy, filtered, store]);

  const flatGroups = useMemo(
    () => flattenLifeNestGroups(nestGroups, groupBy === 'none' ? {} : collapsed),
    [nestGroups, collapsed, groupBy],
  );
  const visibleIds = useMemo(
    () => collectNestItemIds(nestGroups, groupBy === 'none' ? {} : collapsed),
    [nestGroups, collapsed, groupBy],
  );
  const selection = useLifeSelection(visibleIds);

  async function patch(id: string, patchBody: Record<string, unknown>) {
    try {
      await updateItem('krTasks', id, patchBody);
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

  function draftOf(item: KrTaskItem): KrTaskItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patch: Partial<KrTaskItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function commitDraft(item: KrTaskItem) {
    const d = drafts[item.id];
    if (!d) return;
    const title = (d.title ?? item.title).trim();
    if (!title) {
      setError('任务描述不能为空');
      return;
    }
    await patch(item.id, { ...d, title });
  }

  async function saveFromDrawer(draft: Draft, id: string) {
    await updateItem('krTasks', id, draft);
    showToast('已保存', 'success');
  }

  function renderNewRow() {
    if (!newRow) return null;
    const objective = objectiveById(store, newRow.objectiveId);
    const pri = newRow.priority;
    return (
      <tr className="tw-new-row">
        <td className="px-2 py-1 align-middle" />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <input
            autoFocus
            disabled={adding}
            value={newRow.title}
            placeholder="输入任务描述，回车或点空白处保存"
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
        {fields.isVisible('status') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              hideChevron
              centerContent
              ariaLabel="任务状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={newRow.status}
              onChange={(next) =>
                setNewRow((prev) => (prev ? { ...prev, status: next as KrTaskStatus } : prev))
              }
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${KR_TASK_STATUS_CELL[newRow.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={KR_TASK_STATUS_LABEL[newRow.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${KR_TASK_STATUS_DOT[o.value as KrTaskStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('priority') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              hideChevron
              ariaLabel="重要紧急程度"
              options={PRIORITY_OPTIONS}
              value={newRow.priority}
              onChange={(next) =>
                setNewRow((prev) => (prev ? { ...prev, priority: next as LifePriority } : prev))
              }
              triggerClassName={pri ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER}
              renderTrigger={() =>
                pri ? (
                  <span
                    className={`inline-flex h-7 max-w-full items-center truncate rounded-md px-2 text-xs font-medium ${LIFE_PRIORITY_PILL[pri]}`}
                  >
                    <OverflowHint
                      text={LIFE_PRIORITY_LABEL[pri]}
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
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${LIFE_PRIORITY_DOT[o.value as LifePriority]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('planType') ? (
          <td className="px-1 py-1 align-middle">
            <LifePlanTypeSelect
              unstyled
              pill
              planTypes={store.planTypes}
              value={newRow.planType}
              onChange={(next) => setNewRow((prev) => (prev ? { ...prev, planType: next } : prev))}
              mutate={planTypeMutate}
            />
          </td>
        ) : null}
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
                setNewRow((prev) => (prev ? { ...prev, objectiveId: next } : prev))
              }
              triggerClassName={
                objective
                  ? 'h-8 w-full rounded-md border border-transparent px-1.5 text-sm hover:border-stone-200'
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
              label={objectiveYearText(objective)}
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
        {fields.isVisible('todoList') ? (
          <td className="px-2 py-1 align-middle">
            <ReadonlyCell text="—" muted />
          </td>
        ) : null}
        {fields.isVisible('todos') ? (
          <td className="px-2 py-1 text-xs text-stone-400 tabular-nums">0</td>
        ) : null}
        {fields.isVisible('summary') ? (
          <td className="px-2 py-1 align-middle">
            <ReadonlyCell text="—" muted />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressBar value={0} />
          </td>
        ) : null}
        {fields.isVisible('note') ? (
          <td className="px-1 py-1 align-middle">
            <NoteCell
              value={newRow.note}
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, note: v } : prev))}
              onCommit={() => void submitNewRow()}
              onCancel={() =>
                setNewRow((prev) => (prev ? { ...prev, note: prev.base.note } : prev))
              }
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
        'krTasks',
        targets.map((t) => t.id),
      );
      selection.clear();
      showToast(targets.length > 1 ? `已删除 ${targets.length} 条` : '已删除', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(`删除失败：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderRow(item: KrTaskItem, index: number, depth = 0) {
    const row = draftOf(item);
    const objective = objectiveById(store, row.objectiveId);
    const stats = krTaskTodoStats(row.id, store.krTodos);
    const pri = row.priority;
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
            placeholder="任务描述"
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
        {fields.isVisible('status') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              hideChevron
              centerContent
              ariaLabel="任务状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={row.status}
              onChange={(next) => void patch(item.id, { status: next })}
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${KR_TASK_STATUS_CELL[row.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={KR_TASK_STATUS_LABEL[row.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${KR_TASK_STATUS_DOT[o.value as KrTaskStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('priority') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              hideChevron
              ariaLabel="重要紧急程度"
              options={PRIORITY_OPTIONS}
              value={row.priority}
              onChange={(next) => void patch(item.id, { priority: next })}
              triggerClassName={pri ? LIFE_FILLED_PILL_TRIGGER : LIFE_EMPTY_SELECT_TRIGGER}
              renderTrigger={() =>
                pri ? (
                  <span
                    className={`inline-flex h-7 max-w-full items-center truncate rounded-md px-2 text-xs font-medium ${LIFE_PRIORITY_PILL[pri]}`}
                  >
                    <OverflowHint
                      text={LIFE_PRIORITY_LABEL[pri]}
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
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${LIFE_PRIORITY_DOT[o.value as LifePriority]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('planType') ? (
          <td className="px-1 py-1 align-middle">
            <LifePlanTypeSelect
              unstyled
              pill
              planTypes={store.planTypes}
              value={row.planType}
              onChange={(next) => void patch(item.id, { planType: next })}
              mutate={planTypeMutate}
            />
          </td>
        ) : null}
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
              onChange={(next) => void patch(item.id, { objectiveId: next })}
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
              label={objectiveYearText(objective)}
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
        {fields.isVisible('todoList') ? (
          <td className="px-2 py-1 align-middle">
            <OverflowHint
              text={stats.titles.length ? stats.titles.join(' · ') : '—'}
              className="block min-w-0 truncate text-xs text-stone-600"
            />
          </td>
        ) : null}
        {fields.isVisible('todos') ? (
          <td className="px-2 py-1 text-xs text-stone-600 tabular-nums">{stats.count}</td>
        ) : null}
        {fields.isVisible('summary') ? (
          <td className="px-2 py-1 align-middle">
            <OverflowHint
              text={stats.summary}
              className="block min-w-0 truncate text-xs text-stone-500"
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressBar value={stats.progress} />
          </td>
        ) : null}
        {fields.isVisible('note') ? (
          <td className="px-1 py-1 align-middle">
            <NoteCell
              value={row.note}
              onChange={(v) => setDraft(item.id, { note: v })}
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

  const statusSummary = useMemo(() => {
    const c: Partial<Record<KrTaskStatus, number>> = {};
    for (const x of store.krTasks) c[x.status] = (c[x.status] ?? 0) + 1;
    const parts = KR_TASK_STATUSES.filter((s) => (c[s] ?? 0) > 0).map(
      (s) => `${KR_TASK_STATUS_LABEL[s]} ${c[s]}`,
    );
    return parts.join(' · ');
  }, [store.krTasks]);

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
        <div className="min-w-0 text-sm text-stone-600">
          共 <span className="font-medium text-stone-800">{store.krTasks.length}</span> 条
          {statusSummary ? <span className="text-stone-400"> · {statusSummary}</span> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索 KR 任务…"
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
          <SelectDropdown
            flat
            className="w-[120px]"
            ariaLabel="状态筛选"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(next) => setStatusFilter(next as StatusFilter)}
          />
          <button
            type="button"
            disabled={busy || selection.selectedIds.length === 0}
            onClick={() => setDeleteTargets(store.krTasks.filter((x) => selection.selected[x.id]))}
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy || adding}
            onClick={() => {
              const leaf = flatGroups.find((g) => g.items !== undefined);
              startNewRow(leaf?.key ?? 'all', leaf ? presetFromGroupKey(leaf.key) : undefined);
            }}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建任务
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
                任务描述
                <ColumnResizeHandle {...cols.resizeProps('title')} />
              </th>
              {fields.isVisible('status') ? (
                <th className={LIFE_TH}>
                  状态
                  <ColumnResizeHandle {...cols.resizeProps('status')} />
                </th>
              ) : null}
              {fields.isVisible('priority') ? (
                <th className={LIFE_TH}>
                  重要紧急程度
                  <ColumnResizeHandle {...cols.resizeProps('priority')} />
                </th>
              ) : null}
              {fields.isVisible('planType') ? (
                <th className={LIFE_TH}>
                  计划类型
                  <ColumnResizeHandle {...cols.resizeProps('planType')} />
                </th>
              ) : null}
              {fields.isVisible('objective') ? (
                <th className={LIFE_TH_CLUSTER}>
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
              {fields.isVisible('todoList') ? (
                <th className={LIFE_TH_CLUSTER}>
                  待办列表
                  <ColumnResizeHandle {...cols.resizeProps('todoList')} />
                </th>
              ) : null}
              {fields.isVisible('todos') ? (
                <th className={LIFE_TH}>
                  待办数
                  <ColumnResizeHandle {...cols.resizeProps('todos')} />
                </th>
              ) : null}
              {fields.isVisible('summary') ? (
                <th className={LIFE_TH}>
                  待办摘要
                  <ColumnResizeHandle {...cols.resizeProps('summary')} />
                </th>
              ) : null}
              {fields.isVisible('progress') ? (
                <th className={LIFE_TH_CLUSTER}>
                  完成度
                  <ColumnResizeHandle {...cols.resizeProps('progress')} />
                </th>
              ) : null}
              {fields.isVisible('note') ? (
                <th className={LIFE_TH}>
                  备注
                  <ColumnResizeHandle {...cols.resizeProps('note')} />
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
                  {store.krTasks.length === 0 ? '还没有 KR 任务' : '没有匹配的记录'}
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
                    {g.items ? (
                      newRow?.groupKey === g.key ? (
                        renderNewRow()
                      ) : filtered.length > 0 ? (
                        <LifeAddRecordRow
                          colSpan={colCount}
                          depth={g.depth}
                          selectColPx={lifeSelectColPx(nestIndent)}
                          disabled={busy || adding}
                          onClick={() => startNewRow(g.key, presetFromGroupKey(g.key))}
                        />
                      ) : null
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
        <span className="ml-auto text-stone-400">待办进度由关联 KR 待办自动汇总</span>
      </div>

      {editItem ? (
        <KrTaskDrawer
          open
          item={editItem}
          objectiveOptions={objectiveOptions}
          store={store}
          mutate={planTypeMutate}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除 KR 任务'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条任务？关联待办会保留但可能失去任务关联。`
            : `删除「${deleteTargets?.[0]?.title ?? ''}」？关联待办会保留但可能失去任务关联。`
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
