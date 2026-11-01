/**
 * 人生管理「计划类型」目录下拉：可搜索、回车新增、行内改名 / 删除。
 * 选项按 updatedAt 降序；空值显示「未选择」（表格内为整格单选触发器）。
 * 改名 / 删除走 NamePromptDialog / ConfirmDialog，不用原生 prompt / confirm。
 */
import { useMemo, useState, type ReactNode } from 'react';

import { planTypeLabel, sortPlanTypes, type PlanTypeItem } from '../../lib/life';
import ConfirmDialog from './ConfirmDialog';
import NamePromptDialog from './NamePromptDialog';
import OverflowHint from './OverflowHint';
import { PmIcon } from './PmShared';
import {
  LIFE_EMPTY_SELECT_TRIGGER,
  LIFE_FILLED_PILL_TRIGGER,
  LIFE_UNSELECTED_LABEL,
  lifeCatalogCellClass,
} from './LifeShared';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';

const PLACEHOLDER = LIFE_UNSELECTED_LABEL;

type Mutate = {
  createItems: (
    entity: 'planTypes',
    items: Record<string, unknown>[],
  ) => Promise<{ items: unknown[]; total: number }>;
  updateItem: (entity: 'planTypes', id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteItems: (entity: 'planTypes', ids: string[]) => Promise<void>;
};

type Props = {
  planTypes: readonly PlanTypeItem[];
  value: string;
  onChange: (next: string) => void;
  mutate: Mutate;
  flat?: boolean;
  unstyled?: boolean;
  /** 表格单元格：按目录 id 上色胶囊 */
  pill?: boolean;
  className?: string;
  triggerClassName?: string;
  ariaLabel?: string;
  searchPlaceholder?: string;
  /** 空值时触发器文案，默认「未选择」 */
  placeholder?: string;
  renderTrigger?: (label: string, state: { open: boolean; empty: boolean }) => ReactNode;
};

export default function LifePlanTypeSelect(props: Props) {
  const {
    planTypes,
    value,
    onChange,
    mutate,
    flat,
    unstyled,
    pill,
    className,
    triggerClassName,
    ariaLabel = '计划类型',
    searchPlaceholder = '搜索类型…',
    placeholder = PLACEHOLDER,
    renderTrigger,
  } = props;
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PlanTypeItem | null>(null);
  const [renameError, setRenameError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PlanTypeItem | null>(null);

  const sorted = useMemo(() => sortPlanTypes(planTypes), [planTypes]);
  const options = useMemo(() => sorted.map((t) => ({ value: t.id, label: t.name })), [sorted]);
  // 空或不在目录里：保持空，展示占位；不回落到第一项
  const resolved = value && options.some((o) => o.value === value) ? value : '';
  const empty = !resolved;
  const label = empty ? placeholder : planTypeLabel(sorted, resolved);

  async function createFromQuery(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = sorted.find((t) => t.name === trimmed);
    if (existing) {
      onChange(existing.id);
      return;
    }
    setBusy(true);
    try {
      const result = await mutate.createItems('planTypes', [{ name: trimmed }]);
      const created = result.items[0] as PlanTypeItem | undefined;
      if (created?.id) onChange(created.id);
      showToast(`已新增「${trimmed}」`, 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRename(name: string) {
    const item = renameTarget;
    if (!item) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === item.name) {
      setRenameTarget(null);
      setRenameError('');
      return;
    }
    setBusy(true);
    setRenameError('');
    try {
      await mutate.updateItem('planTypes', item.id, { name: trimmed });
      setRenameTarget(null);
      showToast('已修改类型名称', 'success');
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const item = deleteTarget;
    if (!item) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await mutate.deleteItems('planTypes', [item.id]);
      if (resolved === item.id) onChange('');
      showToast('已删除类型', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const pillTrigger = pill
    ? empty
      ? LIFE_EMPTY_SELECT_TRIGGER
      : LIFE_FILLED_PILL_TRIGGER
    : undefined;

  return (
    <>
      <SelectDropdown
        flat={flat}
        unstyled={unstyled}
        centerContent={false}
        className={className}
        triggerClassName={pillTrigger ?? triggerClassName}
        searchable
        searchPlaceholder={searchPlaceholder}
        ariaLabel={ariaLabel}
        options={options}
        value={resolved}
        onChange={onChange}
        onSearchCreate={(q) => void createFromQuery(q)}
        renderTrigger={
          renderTrigger
            ? (_opt, state) => renderTrigger(label, { ...state, empty })
            : () =>
                pill && !empty ? (
                  <span
                    className={`inline-flex h-7 max-w-full items-center truncate rounded-md px-2 text-xs font-medium ${lifeCatalogCellClass(resolved)}`}
                  >
                    <OverflowHint text={label} className="block min-w-0 truncate" />
                  </span>
                ) : (
                  <OverflowHint
                    text={label}
                    className={`block min-w-0 truncate ${
                      empty || options.length === 0 ? 'text-stone-400' : 'text-stone-800'
                    }`}
                  />
                )
        }
        renderOptionAction={(option) => (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              aria-label={`修改 ${option.label}`}
              className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-100 hover:text-stone-700 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
              onClick={() => {
                const item = sorted.find((t) => t.id === option.value);
                if (!item) return;
                setRenameError('');
                setRenameTarget(item);
              }}
            >
              <PmIcon name="pencil" size={13} />
            </button>
            <button
              type="button"
              disabled={busy}
              aria-label={`删除 ${option.label}`}
              className="tw-icon-danger rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 disabled:group-hover:opacity-40"
              onClick={() => {
                const item = sorted.find((t) => t.id === option.value);
                if (item) setDeleteTarget(item);
              }}
            >
              <PmIcon name="trash" size={13} />
            </button>
          </span>
        )}
      />

      <NamePromptDialog
        open={renameTarget != null}
        title="修改计划类型"
        label="类型名称"
        placeholder="请输入类型名称"
        initialValue={renameTarget?.name ?? ''}
        confirmLabel="保存"
        cancelLabel="取消"
        error={renameError}
        onClose={() => {
          setRenameTarget(null);
          setRenameError('');
        }}
        onConfirm={(name) => void confirmRename(name)}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title="删除计划类型"
        message={`删除「${deleteTarget?.name ?? ''}」？已引用该类型的记录会清空类型。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
