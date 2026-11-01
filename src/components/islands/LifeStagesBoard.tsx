/**
 * 人生阶段：可按人生周期 / 计划类型分组、批量删除、行内新增、抽屉仅编辑、行内改。
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  filterByKeyword,
  lifeCycleLabel,
  planTypeLabel,
  sortLifeCycles,
  sortPlanTypes,
  type LifeCycleItem,
  type LifeStageItem,
  type PlanTypeItem,
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
import LifeLifeCycleSelect from './LifeLifeCycleSelect';
import LifePlanTypeSelect from './LifePlanTypeSelect';
import OverflowHint from './OverflowHint';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import {
  formatLifeTimestamp,
  ReadonlyCell,
  LIFE_NEW_ROW_TITLE_INPUT,
  LIFE_TH,
  LIFE_UNSELECTED_LABEL,
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
  LifeProgressControl,
  LifeSelectCell,
  LifeSelectHead,
  TextCell,
  lifeCatalogCellClass,
  lifePluginDisabledMessage,
  lifeSelectColPx,
  lifeStickyTitleStyle,
  sortByCreated,
  useLifeEnumPref,
  useLifeInlineNewRow,
  useLifeKeyword,
  useLifePlugin,
  useLifeSelection,
  useLifeFieldVisibility,
  useLifeStore,
} from './LifeShared';

const COLS = [
  { key: 'select', width: 36, min: 32 },
  { key: 'title', width: 220, min: 160 },
  { key: 'lifeCycle', width: 160, min: 120 },
  { key: 'planType', width: 140, min: 100 },
  { key: 'progress', width: 160, min: 120 },
  { key: 'createdAt', width: 120, min: 96 },
  { key: 'updatedAt', width: 120, min: 96 },
  { key: 'filler', filler: true },
  { key: 'action', width: 88, min: 72 },
] as const;

const FIELD_OPTIONS = [
  { key: 'lifeCycle', label: '人生周期' },
  { key: 'planType', label: '计划类型' },
  { key: 'progress', label: '进度' },
  { key: 'createdAt', label: '创建日期' },
  { key: 'updatedAt', label: '修改日期' },
] as const;
const FIELDS_PREF = 'life.stages.fields';

const KEYWORD_PREF = 'life.stages.search';
const GROUP_PREF = 'life.stages.group';
const GROUP_VALUES = ['lifeCycle', 'planType', 'none'] as const;
type GroupBy = (typeof GROUP_VALUES)[number];

const GROUP_BY_OPTIONS = [
  { value: 'none', label: '不分组' },
  { value: 'lifeCycle', label: '按人生周期分组' },
  { value: 'planType', label: '按计划类型分组' },
];

type Draft = { title: string; lifeCycle: string; planType: string; progress: number };

type CatalogMutate = {
  createItems: ReturnType<typeof useLifeStore>['createItems'];
  updateItem: ReturnType<typeof useLifeStore>['updateItem'];
  deleteItems: ReturnType<typeof useLifeStore>['deleteItems'];
};

function emptyDraft(preset?: Partial<Draft>): Draft {
  return {
    title: '',
    lifeCycle: preset?.lifeCycle ?? '',
    planType: preset?.planType ?? '',
    progress: preset?.progress ?? 0,
  };
}

function presetFromGroupKey(key: string): Partial<Draft> {
  const out: Partial<Draft> = {};
  const lifeCycle = /(?:^|\|)lifeCycle:([^|]+)/.exec(key)?.[1];
  if (lifeCycle === 'unset') out.lifeCycle = '';
  else if (lifeCycle) out.lifeCycle = lifeCycle;
  const planType = /(?:^|\|)planType:([^|]+)/.exec(key)?.[1];
  if (planType === 'unset') out.planType = '';
  else if (planType) out.planType = planType;
  return out;
}

type NewRow = Draft & { groupKey: string; base: Draft };

interface StageGroup {
  key: string;
  label: string;
  pill: string;
  items: LifeStageItem[];
}

function StageDrawer(props: {
  open: boolean;
  item: LifeStageItem;
  planTypes: readonly PlanTypeItem[];
  lifeCycles: readonly LifeCycleItem[];
  mutate: CatalogMutate;
  isVisible: (key: string) => boolean;
  onClose: () => void;
  onSave: (draft: Draft, id: string) => Promise<void>;
}) {
  const { open, item, planTypes, lifeCycles, mutate, isVisible, onClose, onSave } = props;
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setDraft({
      title: item.title,
      lifeCycle: item.lifeCycle || '',
      planType: item.planType || '',
      progress: item.progress,
    });
  }, [open, item]);

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setError('请填写阶段名称');
      return;
    }
    setBusy(true);
    try {
      await onSave(
        {
          ...draft,
          title,
          progress: Math.max(0, Math.min(100, draft.progress)),
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
      title="阶段详情"
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
      <FieldRow icon={<IconText />} label="阶段名称">
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
          placeholder="如 第一辈子"
          className={DRAWER_INPUT}
        />
      </FieldRow>
      {isVisible('lifeCycle') ? (
        <FieldRow icon={<IconTask />} label="人生周期">
          <LifeLifeCycleSelect
            flat
            className="w-full"
            lifeCycles={lifeCycles}
            value={draft.lifeCycle}
            onChange={(next) => setDraft({ ...draft, lifeCycle: next })}
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
      {isVisible('planType') ? (
        <FieldRow icon={<IconTask />} label="计划类型">
          <LifePlanTypeSelect
            flat
            className="w-full"
            planTypes={planTypes}
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
      {isVisible('progress') ? (
        <FieldRow icon={<IconTask />} label="进度">
          <div className="px-1 py-1">
            <LifeProgressControl
              value={draft.progress}
              onChange={(n) => setDraft({ ...draft, progress: n })}
            />
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

export default function LifeStagesBoard() {
  const gate = useLifePlugin();
  const { store, live, error, setError, updateItem, createItems, deleteItems } = useLifeStore(
    gate.ready && gate.on,
  );
  const catalogMutate = useMemo(
    () => ({ createItems, updateItem, deleteItems }),
    [createItems, updateItem, deleteItems],
  );
  const fields = useLifeFieldVisibility(FIELDS_PREF, FIELD_OPTIONS);
  const visibleCols = useMemo(() => filterLifeCols(COLS, fields.isVisible), [fields.isVisible]);
  const [keyword, setKeyword] = useLifeKeyword(KEYWORD_PREF);
  const [groupBy, setGroupBy] = useLifeEnumPref(GROUP_PREF, GROUP_VALUES, 'none');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const titleStickyStyle = lifeStickyTitleStyle() as CSSProperties;
  const [deleteTargets, setDeleteTargets] = useState<LifeStageItem[] | null>(null);
  const [editItem, setEditItem] = useState<LifeStageItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Partial<LifeStageItem>>>({});
  const [newRow, setNewRow] = useState<NewRow | null>(null);

  const cols = useColumnWidths('life.stages.cols.v14', visibleCols);
  const scrollRef = useScrollEdges('life.stages');

  const { submit: submitNewRow } = useLifeInlineNewRow({
    row: newRow,
    setRow: setNewRow,
    submitting: adding,
    isPristine: (row) => {
      const b = row.base;
      return (
        !row.title.trim() &&
        row.lifeCycle === b.lifeCycle &&
        row.planType === b.planType &&
        row.progress === b.progress
      );
    },
    onSubmit: async (row) => {
      setAdding(true);
      try {
        await createItems('lifeStages', [
          {
            title: row.title,
            lifeCycle: row.lifeCycle,
            planType: row.planType,
            progress: Math.max(0, Math.min(100, row.progress)),
          },
        ]);
        setNewRow(null);
        showToast('已新增人生阶段', 'success');
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

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    let list = store.lifeStages;
    if (q) {
      list = list.filter((x) => {
        const cycle = lifeCycleLabel(store.lifeCycles, x.lifeCycle).toLowerCase();
        const type = planTypeLabel(store.planTypes, x.planType).toLowerCase();
        return x.title.toLowerCase().includes(q) || cycle.includes(q) || type.includes(q);
      });
    } else {
      list = filterByKeyword(list, keyword);
    }
    return sortByCreated(list);
  }, [store.lifeStages, store.lifeCycles, store.planTypes, keyword]);

  const groups = useMemo<StageGroup[]>(() => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '全部阶段', pill: 'bg-stone-500 text-white', items: filtered }];
    }
    if (groupBy === 'lifeCycle') {
      const cycles = sortLifeCycles(store.lifeCycles);
      const known = new Set(cycles.map((c) => c.id));
      const fromCatalog = cycles
        .map((c) => ({
          key: `lifeCycle:${c.id}`,
          label: c.name,
          pill: lifeCatalogCellClass(c.id),
          items: filtered.filter((x) => x.lifeCycle === c.id),
        }))
        .filter((g) => g.items.length > 0);
      const unset = filtered.filter((x) => !x.lifeCycle || !known.has(x.lifeCycle));
      if (unset.length > 0) {
        fromCatalog.push({
          key: 'lifeCycle:unset',
          label: LIFE_UNSELECTED_LABEL,
          pill: lifeCatalogCellClass(''),
          items: unset,
        });
      }
      return fromCatalog;
    }
    // planType
    const types = sortPlanTypes(store.planTypes);
    const known = new Set(types.map((t) => t.id));
    const fromCatalog = types
      .map((t) => ({
        key: `planType:${t.id}`,
        label: t.name,
        pill: lifeCatalogCellClass(t.id),
        items: filtered.filter((x) => x.planType === t.id),
      }))
      .filter((g) => g.items.length > 0);
    const unset = filtered.filter((x) => !x.planType || !known.has(x.planType));
    if (unset.length > 0) {
      fromCatalog.push({
        key: 'planType:unset',
        label: LIFE_UNSELECTED_LABEL,
        pill: lifeCatalogCellClass(''),
        items: unset,
      });
    }
    return fromCatalog;
  }, [groupBy, filtered, store.lifeCycles, store.planTypes]);

  const visibleGroups = useMemo(() => {
    const nonempty = groups.filter((g) => g.items.length > 0);
    if (nonempty.length > 0) return nonempty;
    if (groupBy === 'none') {
      return groups.length > 0
        ? groups
        : [
            {
              key: 'all',
              label: '全部阶段',
              pill: 'bg-stone-500 text-white',
              items: [] as LifeStageItem[],
            },
          ];
    }
    if (groupBy === 'lifeCycle') {
      return [
        {
          key: 'lifeCycle:unset',
          label: LIFE_UNSELECTED_LABEL,
          pill: lifeCatalogCellClass(''),
          items: [] as LifeStageItem[],
        },
      ];
    }
    return [
      {
        key: 'planType:unset',
        label: LIFE_UNSELECTED_LABEL,
        pill: lifeCatalogCellClass(''),
        items: [] as LifeStageItem[],
      },
    ];
  }, [groupBy, groups]);

  const visibleIds = useMemo(
    () => visibleGroups.flatMap((g) => g.items.map((x) => x.id)),
    [visibleGroups],
  );
  const selection = useLifeSelection(visibleIds);

  async function patch(id: string, patchBody: Record<string, unknown>) {
    try {
      await updateItem('lifeStages', id, patchBody);
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

  function draftOf(item: LifeStageItem): LifeStageItem {
    return { ...item, ...drafts[item.id] };
  }

  function setDraft(id: string, patchBody: Partial<LifeStageItem>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patchBody } }));
  }

  async function commitDraft(item: LifeStageItem) {
    const d = drafts[item.id];
    if (!d) return;
    const title = (d.title ?? item.title).trim();
    if (!title) {
      setError('阶段名称不能为空');
      return;
    }
    await patch(item.id, { ...d, title });
  }

  async function saveFromDrawer(draft: Draft, id: string) {
    await updateItem('lifeStages', id, draft);
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
            placeholder="输入阶段名称，回车或点空白处保存"
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
        {fields.isVisible('lifeCycle') ? (
          <td className="px-1 py-1 align-middle">
            <LifeLifeCycleSelect
              unstyled
              pill
              lifeCycles={store.lifeCycles}
              value={newRow.lifeCycle}
              onChange={(next) => setNewRow((prev) => (prev ? { ...prev, lifeCycle: next } : prev))}
              mutate={catalogMutate}
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
              mutate={catalogMutate}
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressControl
              value={newRow.progress}
              onChange={(n) => setNewRow((prev) => (prev ? { ...prev, progress: n } : prev))}
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
        'lifeStages',
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

  function renderRow(item: LifeStageItem, index: number) {
    const row = draftOf(item);
    const progress = drafts[item.id]?.progress !== undefined ? row.progress : row.progress;
    return (
      <tr key={item.id} className="group/row hover:bg-[#f7f8fa]">
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
            placeholder="如 第一辈子"
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
        {fields.isVisible('lifeCycle') ? (
          <td className="px-1 py-1 align-middle">
            <LifeLifeCycleSelect
              unstyled
              pill
              lifeCycles={store.lifeCycles}
              value={row.lifeCycle || ''}
              onChange={(next) => void patch(item.id, { lifeCycle: next })}
              mutate={catalogMutate}
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
              mutate={catalogMutate}
            />
          </td>
        ) : null}
        {fields.isVisible('progress') ? (
          <td className="px-2 py-1 align-middle">
            <LifeProgressControl
              value={progress}
              onChange={(n) => setDraft(item.id, { progress: n })}
              onCommit={(n) => void patch(item.id, { progress: n })}
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
          共 <span className="font-medium text-stone-800">{store.lifeStages.length}</span> 条
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索人生阶段…"
            className="h-9 w-52 rounded-lg border border-stone-200 px-3 text-sm text-stone-800 outline-none focus:border-[#3370ff]"
          />
          <SelectDropdown
            flat
            className="w-[168px]"
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
              setDeleteTargets(store.lifeStages.filter((x) => selection.selected[x.id]))
            }
            className="h-9 shrink-0 rounded-lg border border-red-200 px-3 text-sm font-medium whitespace-nowrap text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            批量删除
          </button>
          <button
            type="button"
            disabled={busy || adding}
            onClick={() => {
              if (groupBy === 'none') startNewRow('all');
              else {
                const g = visibleGroups[0];
                startNewRow(g?.key ?? 'all', g ? presetFromGroupKey(g.key) : undefined);
              }
            }}
            className="h-9 shrink-0 rounded-lg bg-[#3370ff] px-3 text-sm font-medium whitespace-nowrap text-white hover:bg-[#2b5fd9] disabled:opacity-40"
          >
            + 新建阶段
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
                阶段名称
                <ColumnResizeHandle {...cols.resizeProps('title')} />
              </th>
              {fields.isVisible('lifeCycle') ? (
                <th className={LIFE_TH}>
                  人生周期
                  <ColumnResizeHandle {...cols.resizeProps('lifeCycle')} />
                </th>
              ) : null}
              {fields.isVisible('planType') ? (
                <th className={LIFE_TH}>
                  计划类型
                  <ColumnResizeHandle {...cols.resizeProps('planType')} />
                </th>
              ) : null}
              {fields.isVisible('progress') ? (
                <th className={LIFE_TH}>
                  进度
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
                  {store.lifeStages.length === 0 ? '还没有人生阶段' : '没有匹配的记录'}
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
                        ) : filtered.length > 0 || store.lifeStages.length === 0 ? (
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
        <span className="ml-auto text-stone-400">可添加多个阶段并分别维护进度</span>
      </div>

      {editItem ? (
        <StageDrawer
          open
          item={editItem}
          planTypes={store.planTypes}
          lifeCycles={store.lifeCycles}
          mutate={catalogMutate}
          isVisible={fields.isVisible}
          onClose={() => setEditItem(null)}
          onSave={saveFromDrawer}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTargets != null}
        title={deleteTargets && deleteTargets.length > 1 ? '批量删除' : '删除人生阶段'}
        message={
          deleteTargets && deleteTargets.length > 1
            ? `删除选中的 ${deleteTargets.length} 条阶段？`
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
