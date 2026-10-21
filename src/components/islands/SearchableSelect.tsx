/**
 * 可搜索下拉：触发器只显示当前值（不可编辑），搜索框在菜单里。
 *
 * 为什么不做成可编辑 input（原来的 headless Combobox 写法）：
 * - 用 ComboboxInput 时，值直接是输入框内容，点开就进入「编辑已选值」的状态，
 *   误删一个字就等于清空选择，且输入框里留下的是查询词而不是当前值；
 * - 现在的语义是：触发器是「当前值」的展示（展开时置灰，等同占位描述），
 *   改选只能从菜单里挑；不挑任何项关掉，展示的仍是原值。
 */
import { useMemo } from 'react';

import SelectDropdown, { type SelectOption } from './SelectDropdown';
import OverflowHint from './OverflowHint';

export interface SearchableOption {
  value: string;
  label: string;
}

interface Props {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = '搜索并选择…',
  disabled = false,
  allowEmpty = true,
  emptyLabel = '不选择',
}: Props) {
  const list = useMemo<SelectOption[]>(() => {
    const items: SelectOption[] = options.map((o) => ({ value: o.value, label: o.label }));
    if (!allowEmpty) return items;
    // 「不选择」放最前，弱化配色，和真实选项区分开
    return [{ value: '', label: emptyLabel, muted: true }, ...items];
  }, [options, allowEmpty, emptyLabel]);

  const current = value ? list.find((o) => o.value === value) : undefined;

  return (
    <SelectDropdown
      options={list}
      value={value}
      onChange={onChange}
      disabled={disabled}
      searchable
      searchPlaceholder={placeholder}
      dimWhenOpen
      // 值只在触发器里展示（不可编辑）；太长被省略号截断时悬停出气泡看全称
      renderTrigger={(_option, { open }) =>
        current ? (
          <span className={`min-w-0 flex-1 ${open ? 'text-stone-400' : ''}`}>
            <OverflowHint text={current.label} className="block truncate" />
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-stone-400">{placeholder}</span>
        )
      }
    />
  );
}
