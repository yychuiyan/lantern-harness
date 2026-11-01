/**
 * KR 待办：对齐待办事项——分组、多选批量删除、行内新增、抽屉仅编辑、行内改。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  KR_TODO_STATUSES,
  KR_TODO_STATUS_LABEL,
  LIFE_PRIORITY_LABEL,
  QUARTER_LABEL,
  cycleDays,
  filterByKeyword,
  formatCycleDays,
  todayIso,
  yearCycleLabel,
  type KrTodoItem,
  type KrTodoStatus,
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
  IconDate,
  IconStatus,
  IconTask,
  IconText,
} from './DrawerField';
import SelectDropdown from './SelectDropdown';
import OverflowHint from './OverflowHint';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  DateCell,
  KR_TODO_STATUS_CELL,
  KR_TODO_STATUS_DOT,
  LIFE_EMPTY_SELECT_TRIGGER,
  LIFE_PRIORITY_CELL,
  LIFE_UNLINKED_LABEL,
  LIFE_YEAR_UNSET_LABEL,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  LIFE_TH,
  LIFE_TH_CLUSTER,
  LIFE_NEW_ROW_TITLE_INPUT,
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
  { key: 'title', width: 240, min: 160 },
  { key: 'status', width: 104, min: 76 },
  { key: 'krTask', width: 160, min: 100 },
  { key: 'year', width: 88, min: 72 },
  { key: 'quarter', width: 120, min: 88 },
  { key: 'priority', width: 104, min: 84 },
  { key: 'start', width: 108, min: 88 },
  { key: 'due', width: 108, min: 88 },
  { key: 'cycle', width: 72, min: 56 },
  { key: 'note', width: 140, min: 88 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'status', label: '状态' },
  { key: 'krTask', label: '所属任务' },
  { key: 'year', label: '年度周期' },
  { key: 'quarter', label: '季度周期' },
  { key: 'priority', label: '重要紧急程度' },
  { key: 'start', label: '开始日期' },
  { key: 'due', label: '截止日期' },
  { key: 'cycle', label: '待办周期' },
  { key: 'note', label: '备注' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.kr-todos.fields';

const KEYWORD_PREF = 'life.kr-todos.search';
const GROUP_PREF = 'life.kr-todos.group';
const STATUS_FILTER_PREF = 'life.kr-todos.status';
const GROUP_VALUES = ['yearStatus', 'status', 'none'] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const STATUS_OPTIONS = KR_TODO_STATUSES.map((s) => ({ value: s, label: KR_TODO_STATUS_LABEL[s] }));
/** 分组头用浅底胶囊（对齐参考稿） */
const STATUS_PILL = KR_TODO_STATUS_CELL;

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'yearStatus', label: '按年度 → 状态' },
  { value: 'status', label: '按状态分组' },
];

type StatusFilter = KrTodoStatus | 'all';
const STATUS_FILTER_VALUES = ['all', ...KR_TODO_STATUSES] as const;
const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  ...KR_TODO_STATUSES.map((s) => ({ value: s, label: KR_TODO_STATUS_LABEL[s] })),
];

type Draft = {
  title: string;
  status: KrTodoStatus;
  krTaskId: string;
  startDate: string;
  dueDate: string;
  note: string;
};

function presetFromGroupKey(key: string): Partial<Draft> {
  const m = /(?:^|\|)status:([^|]+)/.exec(key);
  if (!m) return {};
  const status = m[1] as KrTodoStatus;
  if (!KR_TODO_STATUSES.includes(status)) return {};
  return { status };
}

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    status: preset?.status ?? 'pending',
    krTaskId: preset?.krTaskId ?? '',
    startDate: preset?.startDate ?? todayIso(),
    dueDate: preset?.dueDate ?? todayIso(),
    note: preset?.note ?? '',
  };
}

function todoContext(
  item: Pick<KrTodoItem, 'krTaskId'>,
  store: ReturnType<typeof useLifeStore>['store'],
) {
  const task = store.krTasks.find((t) => t.id === item.krTaskId);
  const objective = task ? objectiveById(store, task.objectiveId) : undefined;
  return { task, objective };
}

type NewRow = Draft & { groupKey: string; base: Draft };

function KrTodoDrawer(props: {
  open: boolean;
  item: KrTodoItem;
  taskOptions: { value: string; label: string }[];
  store: ReturnType<typeof useLifeStore>['store'];
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const { open, item, taskOptions, store, isVisible, onClose, onSave } = props;
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
      krTaskId: item.krTaskId,
      startDate: item.startDate || todayIso(),
      dueDate: item.dueDate || todayIso(),
      note: item.note,
    });
  }, [open, item]);

  const ctx = todoContext(draft, store);
  const cycle = formatCycleDays(cycleDays(draft.startDate, draft.dueDate));

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写待办描述');
      return;
    }
    setBusy(true);
    try {
      await onSave({ ...draft, title }, item.id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LifeDrawer
      open={open}
      title="待办详情"
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
      <FieldRow icon={<IconText />} label="待办描述">
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
        <FieldRow icon={<IconStatus />} label="待办状态">
          <DrawerSelect
            ariaLabel="待办状态"
            options={STATUS_OPTIONS}
            value={draft.status}
            onChange={(next) => setDraft({ ...draft, status: next as KrTodoStatus })}
            label={KR_TODO_STATUS_LABEL[draft.status]}
            optionDotClassName={(v) => KR_TODO_STATUS_DOT[v as KrTodoStatus]}
          />
        </FieldRow>
      ) : null}
      {isVisible('krTask') ? (
        <FieldRow icon={<IconTask />} label="所属任务">
          <SelectDropdown
            flat
            searchable
            searchPlaceholder="搜索 KR 任务…"
            ariaLabel="所属任务"
            options={taskOptions}
            value={draft.krTaskId}
            onChange={(next) => setDraft({ ...draft, krTaskId: next })}
            className="w-full"
            triggerClassName={draft.krTaskId ? undefined : LIFE_EMPTY_SELECT_TRIGGER}
            renderTrigger={() => {
              const task = store.krTasks.find((t) => t.id === draft.krTaskId);
              return task ? (
                <OverflowHint text={task.title} className="block min-w-0 truncate text-stone-800" />
              ) : (
                <OverflowHint
                  text={LIFE_UNLINKED_LABEL}
                  className="block min-w-0 truncate text-stone-400"
                />
              );
            }}
          />
        </FieldRow>
      ) : null}
      {isVisible('year') ? (
        <FieldRow icon={<IconTask />} label="年度周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {ctx.objective?.yearCycle?.trim()
              ? yearCycleLabel(store.yearCycles, ctx.objective.yearCycle) || '—'
              : '—'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('quarter') ? (
        <FieldRow icon={<IconTask />} label="季度周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {ctx.objective?.quarter ? QUARTER_LABEL[ctx.objective.quarter] : '—'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('priority') ? (
        <FieldRow icon={<IconStatus />} label="重要紧急程度">
          <div className="px-2 py-1.5 text-sm text-stone-500">
            {ctx.task?.priority ? LIFE_PRIORITY_LABEL[ctx.task.priority] : '—'}
          </div>
        </FieldRow>
      ) : null}
      {isVisible('start') ? (
        <FieldRow icon={<IconDate />} label="开始日期">
          <DateCell
            value={draft.startDate}
            onChange={(v) => setDraft({ ...draft, startDate: v })}
          />
        </FieldRow>
      ) : null}
      {isVisible('due') ? (
        <FieldRow icon={<IconDate />} label="截止日期">
          <DateCell value={draft.dueDate} onChange={(v) => setDraft({ ...draft, dueDate: v })} />
        </FieldRow>
      ) : null}
      {isVisible('cycle') ? (
        <FieldRow icon={<IconDate />} label="待办周期">
          <div className="px-2 py-1.5 text-sm text-stone-500">{cycle}</div>
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

export default function LifeKrTodosBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const nestIndent = groupBy === 'yearStatus';
  const titleStickyStyle = lifeStickyTitleStyle(nestIndent) as CSSProperties;
  const [statusFilter, setStatusFilter] = useLifeEnumPref(
    STATUS_FILTER_PREF,
    STATUS_FILTER_VALUES,
    'all',
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [deleteTargets, setDeleteTargets] = useState<KrTodoItem[] | null>(null);
  const [editItem, setEditItem] = useState<KrTodoItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<NewRow | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<KrTodoItem>>>({});

  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const visibleCols = useMemo(() => {
    const w = lifeSelectColPx(nestIndent);
    return filterLifeCols(COLS, fields.isVisible).map((c) =>
      c.key === 'select' ? { ...c, width: w, min: w } : c,
    );
  }, [fields.isVisible, nestIndent]);
  const cols = useColumnWidths('life.kr-todos.cols.v12', visibleCols);

  const objectiveYearText = (
    objective: ReturnType<typeof objectiveById>,
    emptyLabel = '随任务',
  ) => {
    const id = objective?.yearCycle?.trim() || '';
    if (!id) return emptyLabel;
    return yearCycleLabel(store.yearCycles, id) || emptyLabel;
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
        row.krTaskId === b.krTaskId &&
        row.startDate === b.startDate &&
        row.dueDate === b.dueDate &&
        row.note === b.note
      );
    },
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('krTodos', [
          {
            title: row.title,
            status: row.status,
            krTaskId: row.krTaskId,
            startDate: row.startDate,
            dueDate: row.dueDate,
            note: row.note,
          },
        ]);
        setNewRow(null);
        showToast('已新增 KR 待办', 'success');
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
  const scrollRef = useScrollEdges('life.kr-todos');

  const taskOptions = useMemo(
    () => [
      { value: '', label: LIFE_UNLINKED_LABEL },
      ...sortByUpdated(store.krTasks).map((t) => ({ value: t.id, label: t.title })),
    ],
    [store.krTasks],
  );

  const filtered = useMemo(() => {
    let list = filterByKeyword(store.krTodos, keyword);
    if (statusFilter !== 'all') list = list.filter((x) => x.status === statusFilter);
    return sortByStatusThenCreated(list, KR_TODO_STATUSES);
  }, [store.krTodos, keyword, statusFilter]);

  const nestGroups = useMemo<LifeNestGroup<KrTodoItem>[]>(() => {
    if (groupBy === 'none') {
      return [
        {
          key: 'all',
          label: '全部待办',
          pill: 'bg-stone-500 text-white',
          items: filtered,
        },
      ];
    }
    if (groupBy === 'status') {
      return KR_TODO_STATUSES.map((s) => ({
        key: `status:${s}`,
        label: KR_TODO_STATUS_LABEL[s],
        pill: STATUS_PILL[s],
        items: filtered.filter((x) => x.status === s),
      }));
    }
    // 年度 → 状态（截图默认）
    const yearIdOf = (item: KrTodoItem) => {
      const ctx = todoContext(item, store);
      return ctx.objective?.yearCycle?.trim() || '';
    };
    const yearLabelOf = (id: string) =>
      id ? yearCycleLabel(store.yearCycles, id) || LIFE_YEAR_UNSET_LABEL : LIFE_YEAR_UNSET_LABEL;
    const yearIds = [...new Set(filtered.map(yearIdOf))];
    yearIds.sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return yearLabelOf(b).localeCompare(yearLabelOf(a), undefined, { numeric: true });
    });
    // 无数据时 flatten 会跳过空父级，导致「+ 新建待办」的 draft 无处渲染
    if (yearIds.length === 0) {
      return [
        {
          key: 'year:',
          label: LIFE_YEAR_UNSET_LABEL,
          pill: lifeCatalogCellClass(''),
          items: [] as KrTodoItem[],
        },
      ];
    }
    // 年度 → 状态：只保留有数据的状态子组，避免空状态撑出多行
    return yearIds
      .map((id) => {
        const inYear = filtered.filter((x) => yearIdOf(x) === id);
        const label = yearLabelOf(id);
        const children = KR_TODO_STATUSES.map((s) => ({
          key: `year:${id}|status:${s}`,
          label: KR_TODO_STATUS_LABEL[s],
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

  async function patch(id: string, patch: Record<string, unknown>) {
    try {
      await updateItem('krTodos', id, patch);
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

  function draftOf(item: KrTodoItem): KrTodoItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patch: Partial<KrTodoItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function commitDraft(item: KrTodoItem) {
    const d = drafts[item.id];
    if (!d) return;
    const title = (d.title ?? item.title).trim();
    if (!title) {
      setError('待办描述不能为空');
      return;
    }
    await patch(item.id, { ...d, title });
  }

  async function saveFromDrawer(draft: Draft, id: string) {
    await updateItem('krTodos', id, draft);
    showToast('已保存', 'success');
  }

  function renderNewRow() {
    if (!newRow) return null;
    const ctx = todoContext(newRow, store);
    const cycle = formatCycleDays(cycleDays(newRow.startDate, newRow.dueDate));
    const pri = ctx.task?.priority ?? '';
    return (
      <tr className="tw-new-row">
        <td className="px-2 py-1 align-middle" />
        <td className={STICKY_CELL_L} style={titleStickyStyle}>
          <input
            autoFocus
            disabled={adding}
            value={newRow.title}
            placeholder="输入待办描述，回车或点空白处保存"
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
              ariaLabel="待办状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={newRow.status}
              onChange={(next) =>
                setNewRow((prev) => (prev ? { ...prev, status: next as KrTodoStatus } : prev))
              }
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${KR_TODO_STATUS_CELL[newRow.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={KR_TODO_STATUS_LABEL[newRow.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${KR_TODO_STATUS_DOT[o.value as KrTodoStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('krTask') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              searchable
              searchPlaceholder="搜索 KR 任务…"
              ariaLabel="KR 任务"
              menuMinWidth={220}
              options={taskOptions}
              value={newRow.krTaskId}
              onChange={(next) => setNewRow((prev) => (prev ? { ...prev, krTaskId: next } : prev))}
              triggerClassName={
                newRow.krTaskId
                  ? 'h-8 w-full rounded-md border border-transparent px-1.5 text-sm hover:border-stone-200'
                  : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() => {
                const task = store.krTasks.find((t) => t.id === newRow.krTaskId);
                return task ? (
                  <OverflowHint
                    text={task.title}
                    className="block min-w-0 truncate text-stone-800"
                  />
                ) : (
                  <OverflowHint
                    text={LIFE_UNLINKED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                );
              }}
            />
          </td>
        ) : null}
        {fields.isVisible('year') ? (
          <td className="px-1 py-1 align-middle">
            <LifeCatalogPill
              id={ctx.objective?.yearCycle?.trim() || ''}
              label={objectiveYearText(ctx.objective)}
              emptyLabel="随任务"
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <ReadonlyCell
              text={ctx.objective?.quarter ? QUARTER_LABEL[ctx.objective.quarter] : '随任务'}
              muted={!ctx.objective?.quarter}
            />
          </td>
        ) : null}
        {fields.isVisible('priority') ? (
          <td className="px-1.5 py-1 align-middle">
            {pri ? (
              <span
                className={`inline-flex h-7 max-w-full items-center justify-center truncate rounded-md px-2 text-center text-xs font-medium ${LIFE_PRIORITY_CELL[pri]}`}
              >
                {LIFE_PRIORITY_LABEL[pri]}
              </span>
            ) : (
              <ReadonlyCell text="随任务" muted />
            )}
          </td>
        ) : null}
        {fields.isVisible('start') ? (
          <td className="px-1 py-1 align-middle">
            <DateCell
              value={newRow.startDate}
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, startDate: v } : prev))}
            />
          </td>
        ) : null}
        {fields.isVisible('due') ? (
          <td className="px-1 py-1 align-middle">
            <DateCell
              value={newRow.dueDate}
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, dueDate: v } : prev))}
            />
          </td>
        ) : null}
        {fields.isVisible('cycle') ? (
          <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-500 tabular-nums">
            {cycle}
          </td>
        ) : null}
        {fields.isVisible('note') ? (
          <td className="px-1 py-1 align-middle">
            <NoteCell
              value={newRow.note}
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, note: v } : prev))}
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
        'krTodos',
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

  function renderRow(item: KrTodoItem, index: number, depth = 0) {
    const row = draftOf(item);
    const ctx = todoContext(row, store);
    const cycle = formatCycleDays(cycleDays(row.startDate, row.dueDate));
    const pri = ctx.task?.priority ?? '';
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
            placeholder="待办描述"
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
              ariaLabel="待办状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={row.status}
              onChange={(next) => void patch(item.id, { status: next })}
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${KR_TODO_STATUS_CELL[row.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={KR_TODO_STATUS_LABEL[row.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${KR_TODO_STATUS_DOT[o.value as KrTodoStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('krTask') ? (
          <td className="px-1 py-1 align-middle">
            <SelectDropdown
              unstyled
              searchable
              searchPlaceholder="搜索 KR 任务…"
              ariaLabel="KR 任务"
              menuMinWidth={220}
              options={taskOptions}
              value={row.krTaskId}
              onChange={(next) => void patch(item.id, { krTaskId: next })}
              triggerClassName={
                row.krTaskId
                  ? 'h-8 w-full rounded-md border border-transparent px-1.5 text-sm hover:border-stone-200'
                  : LIFE_EMPTY_SELECT_TRIGGER
              }
              renderTrigger={() => {
                const task = store.krTasks.find((t) => t.id === row.krTaskId);
                return task ? (
                  <OverflowHint
                    text={task.title}
                    className="block min-w-0 truncate text-stone-800"
                  />
                ) : (
                  <OverflowHint
                    text={LIFE_UNLINKED_LABEL}
                    className="block min-w-0 truncate text-stone-400"
                  />
                );
              }}
            />
          </td>
        ) : null}
        {fields.isVisible('year') ? (
          <td className="px-1 py-1 align-middle">
            <LifeCatalogPill
              id={ctx.objective?.yearCycle?.trim() || ''}
              label={objectiveYearText(ctx.objective)}
              emptyLabel="随任务"
            />
          </td>
        ) : null}
        {fields.isVisible('quarter') ? (
          <td className="px-1 py-1 align-middle">
            <ReadonlyCell
              text={ctx.objective?.quarter ? QUARTER_LABEL[ctx.objective.quarter] : '随任务'}
              muted={!ctx.objective?.quarter}
            />
          </td>
        ) : null}
        {fields.isVisible('priority') ? (
          <td className="px-1.5 py-1 align-middle">
            {pri ? (
              <span
                className={`inline-flex h-7 max-w-full items-center justify-center truncate rounded-md px-2 text-center text-xs font-medium ${LIFE_PRIORITY_CELL[pri]}`}
              >
                {LIFE_PRIORITY_LABEL[pri]}
              </span>
            ) : (
              <ReadonlyCell text="随任务" muted />
            )}
          </td>
        ) : null}
        {fields.isVisible('start') ? (
          <td className="px-1 py-1 align-middle">
            <DateCell
              value={row.startDate}
              onChange={(v) => void patch(item.id, { startDate: v })}
            />
          </td>
        ) : null}
        {fields.isVisible('due') ? (
          <td className="px-1 py-1 align-middle">
            <DateCell value={row.dueDate} onChange={(v) => void patch(item.id, { dueDate: v })} />
          </td>
        ) : null}
        {fields.isVisible('cycle') ? (
          <td className="px-2 py-1 align-middle text-xs whitespace-nowrap text-stone-500 tabular-nums">
            {cycle}
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
    const c: Partial<Record<KrTodoStatus, number>> = {};
    for (const x of store.krTodos) c[x.status] = (c[x.status] ?? 0) + 1;
    const parts = KR_TODO_STATUSES.filter((s) => (c[s] ?? 0) > 0).map(
      (s) => `${KR_TODO_STATUS_LABEL[s]} ${c[s]}`,
    );
    return parts.join(' · ');
  }, [store.krTodos]);

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
          共 <span className="font-medium text-stone-800">{store.krTodos.length}</span> 条
          {statusSummary ? <span className="text-stone-400"> · {statusSummary}</span> : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索待办…"
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
            onClick={() => setDeleteTargets(store.krTodos.filter((x) => selection.selected[x.id]))}
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
            + 新建待办
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
                待办描述
                <ColumnResizeHandle {...cols.resizeProps('title')} />
              </th>
              {fields.isVisible('status') ? (
                <th className={LIFE_TH}>
                  状态
                  <ColumnResizeHandle {...cols.resizeProps('status')} />
                </th>
              ) : null}
              {fields.isVisible('krTask') ? (
                <th className={LIFE_TH_CLUSTER}>
                  KR 任务
                  <ColumnResizeHandle {...cols.resizeProps('krTask')} />
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
              {fields.isVisible('priority') ? (
                <th className={LIFE_TH}>
                  重要紧急程度
                  <ColumnResizeHandle {...cols.resizeProps('priority')} />
                </th>
              ) : null}
              {fields.isVisible('start') ? (
                <th className={LIFE_TH_CLUSTER}>
                  开始日期
                  <ColumnResizeHandle {...cols.resizeProps('start')} />
                </th>
              ) : null}
              {fields.isVisible('due') ? (
                <th className={LIFE_TH}>
                  截止日期
                  <ColumnResizeHandle {...cols.resizeProps('due')} />
                </th>
              ) : null}
              {fields.isVisible('cycle') ? (
                <th className={LIFE_TH}>
                  周期
                  <ColumnResizeHandle {...cols.resizeProps('cycle')} />
                </th>
              ) : null}
              {fields.isVisible('note') ? (
                <th className={LIFE_TH_CLUSTER}>
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
                  {store.krTodos.length === 0 ? '还没有 KR 待办' : '没有匹配的记录'}
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
        <span className="ml-auto text-stone-400">
          年度周期 / 季度周期 / 重要紧急程度跟随关联 KR 任务与 Objective
        </span>
      </div>

      {editItem ? (
        <KrTodoDrawer
          open
          item={editItem}
          taskOptions={taskOptions}
          store={store}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除 KR 待办'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条待办？此操作不可恢复。`
            : `删除「${deleteTargets?.[0]?.title ?? ''}」？此操作不可恢复。`
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
