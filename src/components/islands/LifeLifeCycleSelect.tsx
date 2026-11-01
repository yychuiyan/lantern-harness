/**
 * 人生管理「人生周期」目录下拉：可搜索、回车新增、行内改名 / 删除。
 * 选项按 updatedAt 降序；空值显示「未选择」（表格内为整格单选触发器）。
 * 名称可写「第一辈子(29-34)」这类文案。
 */
import { useMemo, useState, type ReactNode } from 'react';

import { lifeCycleLabel, sortLifeCycles, type LifeCycleItem } from '../../lib/life';
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
    entity: 'lifeCycles',
    items: Record<string, unknown>[],
  ) => Promise<{ items: unknown[]; total: number }>;
  updateItem: (entity: 'lifeCycles', id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteItems: (entity: 'lifeCycles', ids: string[]) => Promise<void>;
};

type Props = {
  lifeCycles: readonly LifeCycleItem[];
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
  placeholder?: string;
  renderTrigger?: (label: string, state: { open: boolean; empty: boolean }) => ReactNode;
};

export default function LifeLifeCycleSelect(props: Props) {
  const {
    lifeCycles,
    value,
    onChange,
    mutate,
    flat,
    unstyled,
    pill,
    className,
    triggerClassName,
    ariaLabel = '人生周期',
    searchPlaceholder = '搜索人生周期…',
    placeholder = PLACEHOLDER,
    renderTrigger,
  } = props;
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LifeCycleItem | null>(null);
  const [renameError, setRenameError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<LifeCycleItem | null>(null);

  const sorted = useMemo(() => sortLifeCycles(lifeCycles), [lifeCycles]);
  const options = useMemo(() => sorted.map((t) => ({ value: t.id, label: t.name })), [sorted]);
  const resolved = value && options.some((o) => o.value === value) ? value : '';
  const empty = !resolved;
  const label = empty ? placeholder : lifeCycleLabel(sorted, resolved);

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
      const result = await mutate.createItems('lifeCycles', [{ name: trimmed }]);
      const created = result.items[0] as LifeCycleItem | undefined;
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
      await mutate.updateItem('lifeCycles', item.id, { name: trimmed });
      setRenameTarget(null);
      showToast('已修改人生周期', 'success');
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
      await mutate.deleteItems('lifeCycles', [item.id]);
      if (resolved === item.id) onChange('');
      showToast('已删除人生周期', 'success');
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
        title="修改人生周期"
        label="人生周期"
        placeholder="例如 第一辈子(29-34)"
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
        title="删除人生周期"
        message={`删除「${deleteTarget?.name ?? ''}」？已引用该周期的人生阶段会清空周期。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
