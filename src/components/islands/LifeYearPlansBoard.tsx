/**
 * 年度计划：按状态 / 年度分组、批量删除、右侧抽屉、行内改。
 * 关联 Objective：点击弹出多行框展示胶囊（可 ×），不做下拉勾选。
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import {
  YEAR_PLAN_STATUSES,
  YEAR_PLAN_STATUS_LABEL,
  filterByKeyword,
  sortYearCycles,
  type ObjectiveItem,
  type PlanTypeItem,
  type YearCycleItem,
  type YearPlanItem,
  type YearPlanStatus,
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
import LifeYearCycleSelect from './LifeYearCycleSelect';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  ReadonlyCell,
  YEAR_PLAN_STATUS_CELL,
  YEAR_PLAN_STATUS_DOT,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  LIFE_TH,
  LifeAddRecordRow,
  LifeDeleteButton,
  LifeFieldConfigButton,
  filterLifeCols,
  LifeDrawer,
  LifeErrorBar,
  LifeExpandButton,
  LifeGroupHeader,
  LifeLoading,
  LifeNotice,
  LifeSelectCell,
  LifeSelectHead,
  TextCell,
  lifeCatalogCellClass,
  LIFE_YEAR_UNSET_LABEL,
  lifePluginDisabledMessage,
  sortByStatusThenCreated,
  useLifeEnumPref,
  useLifeKeyword,
  useLifePlugin,
  useLifeSelection,
  useLifeStore,
  LIFE_NEW_ROW_TITLE_INPUT,
  useLifeFieldVisibility,
  useLifeInlineNewRow,
  type LifeGroup,
} from './LifeShared';

const COLS = [
  { key: 'select', width: 36, min: 32 },
  { key: 'title', width: 220, min: 160 },
  { key: 'yearCycle', width: 120, min: 88 },
  { key: 'planType', width: 112, min: 88 },
  { key: 'status', width: 104, min: 76 },
  { key: 'objectives', width: 280, min: 180 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'yearCycle', label: '年度周期' },
  { key: 'planType', label: '计划类型' },
  { key: 'status', label: '状态' },
  { key: 'objectives', label: '关联 Objective' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.year-plans.fields';

const KEYWORD_PREF = 'life.year-plans.search';
const GROUP_PREF = 'life.year-plans.group';
const GROUP_VALUES = ['status', 'yearCycle', 'none'] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const STATUS_OPTIONS = YEAR_PLAN_STATUSES.map((s) => ({
  value: s,
  label: YEAR_PLAN_STATUS_LABEL[s],
}));

const STATUS_PILL: Record<YearPlanStatus, string> = {
  in_progress: 'bg-[#e1eaff] text-[#1f4ec2]',
  incomplete: 'bg-[#fff1e3] text-[#a85b00]',
  done: 'bg-[#d9f5d2] text-[#1d7a12]',
};

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'status', label: '按状态分组' },
  { value: 'yearCycle', label: '按年度分组' },
];

type Draft = {
  title: string;
  yearCycle: string;
  planType: string;
  status: YearPlanStatus;
  objectiveIds: string[];
};

type PlanTypeMutate = {
  createItems: ReturnType<typeof useLifeStore>['createItems'];
  updateItem: ReturnType<typeof useLifeStore>['updateItem'];
  deleteItems: ReturnType<typeof useLifeStore>['deleteItems'];
};

type YearCycleMutate = PlanTypeMutate;

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    yearCycle: preset?.yearCycle ?? '',
    planType: preset?.planType ?? '',
    status: preset?.status ?? 'in_progress',
    objectiveIds: preset?.objectiveIds ?? [],
  };
}

/** 关联 Objective：点击弹出多行框展示胶囊（可 ×），不提供下拉勾选 */
function YearPlanObjectivesSelect(props: {
  yearCycle: string;
  yearPlanId?: string;
  objectives: readonly ObjectiveItem[];
  values: string[];
  onChange: (ids: string[]) => void;
  /** 抽屉内默认边框；表格内略紧凑 */
  flat?: boolean;
}) {
  const linked = useMemo(() => {
    const ids = new Set(props.values);
    return props.objectives.filter(
      (o) => ids.has(o.id) || (Boolean(props.yearPlanId) && o.yearPlanId === props.yearPlanId),
    );
  }, [props.objectives, props.values, props.yearPlanId]);

  const noYear = !props.yearCycle;
  const empty = linked.length === 0;
  const placeholder = noYear
    ? '先选年度周期'
    : empty
      ? '暂无关联 Objective'
      : `已关联 ${linked.length} 个目标`;

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ left: 0, top: 0, width: 280, openUp: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const disabled = noYear;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onScroll(e: Event) {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function openBox() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(rect.width, 260);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const openUp = below + 200 > window.innerHeight && rect.top > 200;
    setAnchor({
      left,
      top: openUp ? rect.top - 4 : below,
      width,
      openUp,
    });
    setOpen(true);
  }

  function remove(id: string, e: ReactMouseEvent) {
    e.stopPropagation();
    props.onChange(linked.filter((o) => o.id !== id).map((o) => o.id));
  }

  const triggerClass = disabled
    ? 'w-full min-h-8 flex items-center justify-start rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-sm text-left text-stone-400 cursor-not-allowed'
    : props.flat
      ? 'tw-field-trigger w-full min-h-9 flex items-center justify-start rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-left text-stone-800 outline-none hover:border-stone-300 focus:ring-2 focus:ring-[#4176e6]/30'
      : 'tw-field-trigger w-full min-h-8 flex items-center justify-start rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-left text-stone-800 outline-none hover:border-stone-300 focus:ring-1 focus:ring-[#3370ff]/30';

  let panel: ReturnType<typeof createPortal> | null = null;
  if (open && typeof document !== 'undefined') {
    panel = createPortal(
      <div
        ref={panelRef}
        className="tw-select-menu tw-popover-anim fixed z-[1000] overflow-hidden rounded-lg shadow-lg ring-1 ring-stone-200"
        style={{
          left: anchor.left,
          width: anchor.width,
          ...(anchor.openUp ? { bottom: window.innerHeight - anchor.top } : { top: anchor.top }),
        }}
      >
        <div
          className="tw-dsh-scroll max-h-[120px] overflow-y-auto bg-white px-2.5 py-2"
          onWheel={(e) => e.stopPropagation()}
        >
          {empty ? (
            <p className="px-1 py-1 text-sm text-stone-400">
              {noYear ? '先选年度周期' : '暂无关联 Objective，可在 Objective 里选年度计划'}
            </p>
          ) : (
            <div className="flex flex-wrap content-start gap-1.5">
              {linked.map((o) => (
                <span
                  key={o.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-[#e8f0fe] px-2.5 py-0.5 text-[12px] leading-5 text-[#1f4ec2]"
                >
                  <span className="min-w-0 break-words whitespace-pre-wrap">{o.title}</span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`移除 ${o.title}`}
                    className="shrink-0 rounded-full px-0.5 text-[#5b7fd4] hover:bg-[#d2e3fc] hover:text-[#1f4ec2]"
                    onClick={(e) => remove(o.id, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        remove(o.id, e as unknown as ReactMouseEvent);
                      }
                    }}
                  >
                    ×
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={openBox}
        className={triggerClass}
      >
        {empty || disabled ? (
          <span className="text-stone-400">{placeholder}</span>
        ) : (
          <OverflowHint
            text={linked.map((o) => o.title).join('、')}
            className="block min-w-0 flex-1 truncate text-left text-stone-700"
          />
        )}
      </button>
      {panel}
    </div>
  );
}

function presetFromGroupKey(key: string): Partial<Draft> {
  const out: Partial<Draft> = {};
  const status = /(?:^|\|)status:([^|]+)/.exec(key)?.[1];
  if (status && (YEAR_PLAN_STATUSES as readonly string[]).includes(status)) {
    out.status = status as YearPlanStatus;
  }
  const year = /(?:^|\|)year:([^|]+)/.exec(key)?.[1];
  if (year && year !== 'unset') out.yearCycle = year;
  return out;
}

type NewRow = Draft & {
  groupKey: string;
  baseYearCycle: string;
  basePlanType: string;
  baseStatus: YearPlanStatus;
  baseObjectiveIds: string[];
};

function YearPlanDrawer(props: {
  open: boolean;
  item: YearPlanItem;
  yearCycles: readonly YearCycleItem[];
  yearCycleMutate: YearCycleMutate;
  objectives: readonly ObjectiveItem[];
  planTypes: readonly PlanTypeItem[];
  planTypeMutate: PlanTypeMutate;
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const {
    open,
    item,
    yearCycles,
    yearCycleMutate,
    objectives,
    planTypes,
    planTypeMutate,
    isVisible,
    onClose,
    onSave,
  } = props;
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft({
      title: item.title,
      yearCycle: item.yearCycle,
      planType: item.planType || '',
      status: item.status,
      objectiveIds: item.objectiveIds ?? [],
    });
  }, [open, item]);

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写计划标题');
      return;
    }
    setBusy(true);
    try {
      await onSave(
        {
          ...draft,
          title,
          yearCycle: draft.yearCycle,
          objectiveIds: draft.objectiveIds,
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
      title="计划详情"
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
      {isVisible('yearCycle') ? (
        <FieldRow icon={<IconTask />} label="年度周期">
          <LifeYearCycleSelect
            flat
            className="w-full"
            yearCycles={yearCycles}
            value={draft.yearCycle}
            onChange={(next) => setDraft({ ...draft, yearCycle: next })}
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
      {isVisible('planType') ? (
        <FieldRow icon={<IconTask />} label="计划类型">
          <LifePlanTypeSelect
            flat
            className="w-full"
            planTypes={planTypes}
            value={draft.planType}
            onChange={(next) => setDraft({ ...draft, planType: next })}
            mutate={planTypeMutate}
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
      {isVisible('status') ? (
        <FieldRow icon={<IconStatus />} label="状态">
          <DrawerSelect
            ariaLabel="计划状态"
            options={STATUS_OPTIONS}
            value={draft.status}
            onChange={(next) => setDraft({ ...draft, status: next as YearPlanStatus })}
            label={YEAR_PLAN_STATUS_LABEL[draft.status]}
            optionDotClassName={(v) => YEAR_PLAN_STATUS_DOT[v as YearPlanStatus]}
          />
        </FieldRow>
      ) : null}
      {isVisible('objectives') ? (
        <FieldRow icon={<IconTask />} label="关联 Objective">
          <div className="w-full px-0.5 py-0.5">
            <YearPlanObjectivesSelect
              flat
              yearCycle={draft.yearCycle}
              yearPlanId={item.id}
              objectives={objectives}
              values={draft.objectiveIds}
              onChange={(ids) => setDraft({ ...draft, objectiveIds: ids })}
            />
            <p className="mt-1 px-1.5 text-[11px] leading-4 text-stone-400">
              点击查看已关联目标；在 Objective 里选「年度计划」后会自动出现。
            </p>
          </div>
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

export default function LifeYearPlansBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const planTypeMutate = useMemo(
    () => ({ createItems, updateItem, deleteItems }),
    [createItems, updateItem, deleteItems],
  );
  const yearCycleMutate = useMemo(
    () => ({ createItems, updateItem, deleteItems }),
    [createItems, updateItem, deleteItems],
  );
  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const visibleCols = useMemo(() => filterLifeCols(COLS, fields.isVisible), [fields.isVisible]);
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const titleStickyStyle = lifeStickyTitleStyle() as CSSProperties;
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [deleteTargets, setDeleteTargets] = useState<YearPlanItem[] | null>(null);
  const [editItem, setEditItem] = useState<YearPlanItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<YearPlanItem>>>({});
  const [newRow, setNewRow] = useState<NewRow | null>(null);

  const cols = useColumnWidths('life.year-plans.cols.v13', visibleCols);
  const scrollRef = useScrollEdges('life.year-plans');

  const filtered = useMemo(
    () => sortByStatusThenCreated(filterByKeyword(store.yearPlans, keyword), YEAR_PLAN_STATUSES),
    [store.yearPlans, keyword],
  );

  const groups = useMemo<LifeGroup<YearPlanItem>[]>(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '全部计划', pill: 'bg-stone-500 text-white', items: filtered }];
    }
    if (groupBy === 'yearCycle') {
      const cycles = sortYearCycles(store.yearCycles);
      const known = new Set(cycles.map((c) => c.id));
      const fromCatalog = cycles
        .map((c) => ({
          key: `year:${c.id}`,
          label: c.name,
          pill: lifeCatalogCellClass(c.id),
          items: filtered.filter((x) => x.yearCycle === c.id),
        }))
        .filter((g) => g.items.length > 0);
      const orphans = filtered.filter((x) => !x.yearCycle || !known.has(x.yearCycle));
      if (orphans.length > 0) {
        fromCatalog.push({
          key: 'year:unset',
          label: LIFE_YEAR_UNSET_LABEL,
          pill: lifeCatalogCellClass(''),
          items: orphans,
        });
      }
      return fromCatalog;
    }
    return YEAR_PLAN_STATUSES.map((s) => ({
      key: `status:${s}`,
      label: YEAR_PLAN_STATUS_LABEL[s],
      pill: STATUS_PILL[s],
      items: filtered.filter((x) => x.status === s),
    }));
  }, [groupBy, filtered, store.yearCycles]);

  // 按状态分组保留空组（组底可新增）；不分组 / 按年度只展示有数据的组；
  // 全部为空时仍留占位，否则「+ 新建计划」的 draft 无处渲染
  const visibleGroups = useMemo(() => {
    if (groupBy === 'status') return groups;
    const nonempty = groups.filter((g) => g.items.length > 0);
    if (nonempty.length > 0) return nonempty;
    if (groupBy === 'none') {
      return groups.length > 0
        ? groups
        : [
            {
              key: 'all',
              label: '全部计划',
              pill: 'bg-stone-500 text-white',
              items: [] as YearPlanItem[],
            },
          ];
    }
    return [
      {
        key: 'year:unset',
        label: LIFE_YEAR_UNSET_LABEL,
        pill: 'bg-stone-300 text-stone-600',
        items: [] as YearPlanItem[],
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
      row.yearCycle === row.baseYearCycle &&
      row.planType === row.basePlanType &&
      row.status === row.baseStatus &&
      row.objectiveIds.join('|') === row.baseObjectiveIds.join('|'),
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('yearPlans', [
          {
            title: row.title,
            yearCycle: row.yearCycle,
            planType: row.planType,
            status: row.status,
            objectiveIds: row.objectiveIds,
          },
        ]);
        setNewRow(null);
        showToast('已新增年度计划', 'success');
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
    const planType = preset?.planType ?? '';
    const status = preset?.status ?? 'in_progress';
    const yearCycle = preset?.yearCycle ?? '';
    setNewRow({
      groupKey,
      title: '',
      yearCycle,
      planType,
      status,
      objectiveIds: [],
      baseYearCycle: yearCycle,
      basePlanType: planType,
      baseStatus: status,
      baseObjectiveIds: [],
    });
    setCollapsed((prev) => ({ ...prev, [groupKey]: false }));
  }

  async function patch(id: string, patchBody: Record<string, unknown>) {
    try {
      await updateItem('yearPlans', id, patchBody);
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

  function draftOf(item: YearPlanItem): YearPlanItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patch: Partial<YearPlanItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function commitDraft(item: YearPlanItem) {
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
    await updateItem('yearPlans', id, draft);
    showToast('已保存', 'success');
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
            placeholder="输入计划名称，回车或点空白处保存"
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
              onChange={(v) => setNewRow((prev) => (prev ? { ...prev, yearCycle: v } : prev))}
              mutate={yearCycleMutate}
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
        {fields.isVisible('status') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent
              hideChevron
              centerContent
              ariaLabel="计划状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={newRow.status}
              onChange={(next) =>
                setNewRow((prev) => (prev ? { ...prev, status: next as YearPlanStatus } : prev))
              }
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${YEAR_PLAN_STATUS_CELL[newRow.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={YEAR_PLAN_STATUS_LABEL[newRow.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${YEAR_PLAN_STATUS_DOT[o.value as YearPlanStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('objectives') ? (
          <td className="px-1 py-1 align-middle">
            <YearPlanObjectivesSelect
              yearCycle={newRow.yearCycle}
              objectives={store.objectives}
              values={newRow.objectiveIds}
              onChange={(ids) =>
                setNewRow((prev) => (prev ? { ...prev, objectiveIds: ids } : prev))
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
        'yearPlans',
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

  function renderRow(item: YearPlanItem, index: number) {
    const row = draftOf(item);
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
        {fields.isVisible('yearCycle') ? (
          <td className="px-1 py-1 align-middle">
            <LifeYearCycleSelect
              unstyled
              pill
              yearCycles={store.yearCycles}
              value={row.yearCycle}
              onChange={(v) => void patch(item.id, { yearCycle: v })}
              mutate={yearCycleMutate}
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
        {fields.isVisible('status') ? (
          <td className="px-1.5 py-1 align-middle">
            <SelectDropdown
              unstyled
              fitContent
              hideChevron
              centerContent
              ariaLabel="计划状态"
              menuMinWidth={120}
              options={STATUS_OPTIONS}
              value={row.status}
              onChange={(next) => void patch(item.id, { status: next })}
              triggerClassName={`h-7 max-w-full rounded-md px-2 text-center text-xs font-medium focus:ring-2 focus:ring-[#3370ff]/30 ${YEAR_PLAN_STATUS_CELL[row.status]}`}
              renderTrigger={() => (
                <OverflowHint
                  text={YEAR_PLAN_STATUS_LABEL[row.status]}
                  className="block min-w-0 truncate"
                />
              )}
              renderOptionPrefix={(o) => (
                <span
                  className={`h-2 w-2 rounded-full ${YEAR_PLAN_STATUS_DOT[o.value as YearPlanStatus]}`}
                />
              )}
            />
          </td>
        ) : null}
        {fields.isVisible('objectives') ? (
          <td className="px-1 py-1 align-middle">
            <YearPlanObjectivesSelect
              yearCycle={row.yearCycle}
              yearPlanId={item.id}
              objectives={store.objectives}
              values={row.objectiveIds ?? []}
              onChange={(ids) => void patch(item.id, { objectiveIds: ids })}
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
          共 <span className="font-medium text-stone-800">{store.yearPlans.length}</span> 条
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索年度计划…"
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
            onClick={() =>
              setDeleteTargets(store.yearPlans.filter((x) => selection.selected[x.id]))
            }
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy || adding}
            onClick={() => {
              const g = visibleGroups[0];
              startNewRow(g?.key ?? 'all', g ? presetFromGroupKey(g.key) : undefined);
            }}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建计划
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
              {fields.isVisible('yearCycle') ? (
                <th className={LIFE_TH}>
                  年度周期
                  <ColumnResizeHandle {...cols.resizeProps('yearCycle')} />
                </th>
              ) : null}
              {fields.isVisible('planType') ? (
                <th className={LIFE_TH}>
                  计划类型
                  <ColumnResizeHandle {...cols.resizeProps('planType')} />
                </th>
              ) : null}
              {fields.isVisible('status') ? (
                <th className={LIFE_TH}>
                  状态
                  <ColumnResizeHandle {...cols.resizeProps('status')} />
                </th>
              ) : null}
              {fields.isVisible('objectives') ? (
                <th className={LIFE_TH}>
                  关联 Objective
                  <ColumnResizeHandle {...cols.resizeProps('objectives')} />
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
                  {store.yearPlans.length === 0 ? '还没有年度计划' : '没有匹配的记录'}
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
                            onClick={() => startNewRow(g.key, presetFromGroupKey(g.key))}
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
        <span className="ml-auto text-stone-400">
          关联 Objective：点击弹出胶囊框；在 Objective 选年度计划后自动带出
        </span>
      </div>

      {editItem ? (
        <YearPlanDrawer
          open
          item={editItem}
          yearCycles={store.yearCycles}
          yearCycleMutate={yearCycleMutate}
          objectives={store.objectives}
          planTypes={store.planTypes}
          planTypeMutate={planTypeMutate}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除年度计划'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条计划？`
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
