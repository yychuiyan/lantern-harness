import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SelectDropdown from './SelectDropdown';
import MultiSelectDropdown from './MultiSelectDropdown';
import SearchableSelect from './SearchableSelect';
import OverflowHint from './OverflowHint';
import ConfirmDialog from './ConfirmDialog';
import NamePromptDialog from './NamePromptDialog';
import { showToast } from './Toast';
import { openDefectWorkbench, type DefectTemplate } from '../../lib/defect-workbench';
import { PmIcon } from './PmShared';

type FieldRule = DefectTemplate['config']['mapping'][number];
type RuleEditor = {
  id?: string;
  name: string;
  url: string;
  sheetId: string;
  template: string;
  iterations: string[];
  iteration: string;
  fields: FieldRule[];
};
type LinkField = {
  id: string;
  title: string;
  kind: string;
  multiple?: boolean;
  options?: { id: string; label: string }[];
};
type InspectionResult = {
  target: { platform: string };
  sheets: { id: string; title: string }[];
  sheetId: string;
  fields: LinkField[];
};
type OptionTarget = {
  fieldId: string;
  optionId: string;
  label: string;
  source?: string;
};
const INSPECTION_CACHE_KEY = 'lantern:defect-rule-inspection:v1';
const emptyEditor = (): RuleEditor => ({
  name: '',
  url: '',
  sheetId: '',
  template: '',
  iterations: [],
  iteration: '',
  fields: [],
});
async function request(route: string, body?: unknown) {
  const response = await fetch(
    '/__tb_defect_submit' + route,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成，请重试');
  return data;
}

function FieldPills({ fields }: { fields: FieldRule[] }) {
  const host = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(fields.length);
  useLayoutEffect(() => {
    const container = host.current;
    const sizes = measure.current;
    if (!container || !sizes) return;
    function update() {
      const available = container!.clientWidth;
      const widths = [...sizes!.querySelectorAll<HTMLElement>('.dr-pill-size')].map(
        (node) => node.getBoundingClientRect().width,
      );
      const gap = 6;
      const total =
        widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
      if (total <= available) {
        setVisible(fields.length);
        return;
      }
      const counter = sizes!
        .querySelector<HTMLElement>('.dr-pill-counter')!
        .getBoundingClientRect().width;
      let used = 0;
      let count = 0;
      for (const width of widths) {
        if (used + width + gap + counter > available) break;
        used += width + gap;
        count++;
      }
      setVisible(count);
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fields]);
  return (
    <span className="dr-pill-row" ref={host}>
      <span className="dr-tags">
        {fields.slice(0, visible).map((field) => (
          <OverflowHint key={field.id} text={field.label} className="dr-field-chip" />
        ))}
        {visible < fields.length && (
          <OverflowHint
            text={fields
              .slice(visible)
              .map((field) => field.label)
              .join('、')}
            displayText={'+' + (fields.length - visible)}
            className="dr-field-count"
            showWhenFits
          />
        )}
      </span>
      <span className="dr-pill-measure" ref={measure} aria-hidden="true">
        {fields.map((field) => (
          <span key={field.id} className="dr-pill-size">
            {field.label}
          </span>
        ))}
        <span className="dr-pill-counter">+{fields.length}</span>
      </span>
    </span>
  );
}

function hasDefaultValue(field: FieldRule) {
  const value = field.defaultValue;
  return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function visibleOptions(field: FieldRule) {
  const hidden = new Set(field.hiddenOptions || []);
  const labels = field.optionLabels || {};
  return (field.options || [])
    .filter((option) => !hidden.has(option.id))
    .map((option) => ({ ...option, label: labels[option.id]?.trim() || option.label }));
}

function inspectionKey(ruleId: string, url: string, sheetId: string) {
  return [ruleId, url.trim(), sheetId].join('|');
}

function isIterationField(field: FieldRule) {
  return field.label === '迭代版本' || field.id === 'fzrSGl';
}

function mergeIterationLabels(existing: string[], selected = '') {
  return [
    ...new Set(
      [
        ...existing.map((label) => label.trim()).filter((label) => label && label !== '无'),
        selected.trim(),
      ].filter(Boolean),
    ),
  ];
}

function applyIterationToFields(fields: FieldRule[], iteration: string) {
  const selected = iteration.trim();
  return fields.map((field) => {
    if (!isIterationField(field)) return field;
    const option =
      selected && field.kind === 'option'
        ? visibleOptions(field).find((item) => item.label.trim() === selected)
        : undefined;
    return {
      ...field,
      defaultValue: option?.id,
      ...(selected ? { rule: '使用当前规则当前迭代：' + selected + '，不要再次询问。' } : {}),
    };
  });
}

function readInspectionCache(key: string): InspectionResult | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const all = JSON.parse(sessionStorage.getItem(INSPECTION_CACHE_KEY) || '{}') as Record<
      string,
      InspectionResult
    >;
    const cached = all[key];
    if (!cached || !Array.isArray(cached.sheets) || !Array.isArray(cached.fields)) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

function writeInspectionCache(key: string, value: InspectionResult) {
  if (typeof window === 'undefined') return;
  try {
    const all = JSON.parse(sessionStorage.getItem(INSPECTION_CACHE_KEY) || '{}') as Record<
      string,
      InspectionResult
    >;
    const recent = Object.entries(all)
      .filter(([entryKey]) => entryKey !== key)
      .slice(-19);
    sessionStorage.setItem(
      INSPECTION_CACHE_KEY,
      JSON.stringify(Object.fromEntries([...recent, [key, value]])),
    );
  } catch {
    // 隐私模式或容量不足时退回当前页面内存状态，不阻塞识别。
  }
}

function mergeRemoteFieldOptions(fields: FieldRule[], remoteFields: LinkField[]) {
  return fields.map((field) => {
    if (field.source === 'manual') return field;
    const remote = remoteFields.find((item) => item.id === field.id);
    if (!remote) return field;
    return {
      ...field,
      kind: remote.kind,
      options: visibleOptions({ ...field, options: remote.options || [] }),
      multiple: remote.multiple === true,
    };
  });
}

function DefaultValueEditor({
  field,
  index,
  disabled,
  onChange,
  onEditOption,
  onDeleteOption,
}: {
  field: FieldRule;
  index: number;
  disabled: boolean;
  onChange: (value: FieldRule['defaultValue']) => void;
  onEditOption?: (option: OptionTarget) => void;
  onDeleteOption?: (option: OptionTarget) => void;
}) {
  const label = '默认值 ' + (field.label || index + 1);
  const options = visibleOptions(field);
  const renderOptionAction = (option: { value: string; label: string }) => {
    if (!option.value || field.kind !== 'option') return null;
    return (
      <span className="flex items-center gap-0.5">
        {onEditOption ? (
          <button
            type="button"
            disabled={disabled}
            aria-label={`修改选项 ${option.label}`}
            className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-100 hover:text-stone-700 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
            onClick={() =>
              onEditOption({
                fieldId: field.id,
                optionId: option.value,
                label: option.label,
                source: field.source,
              })
            }
          >
            <PmIcon name="pencil" size={13} />
          </button>
        ) : null}
        {onDeleteOption ? (
          <button
            type="button"
            disabled={disabled}
            aria-label={`删除选项 ${option.label}`}
            className="tw-icon-danger rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0 disabled:group-hover:opacity-40"
            onClick={() =>
              onDeleteOption({
                fieldId: field.id,
                optionId: option.value,
                label: option.label,
                source: field.source,
              })
            }
          >
            <PmIcon name="trash" size={13} />
          </button>
        ) : null}
      </span>
    );
  };
  if ((field.kind === 'option' || field.kind === 'reference') && (field.options?.length || 0) > 0) {
    if (field.multiple) {
      const values = Array.isArray(field.defaultValue)
        ? field.defaultValue
        : field.defaultValue === undefined
          ? []
          : [String(field.defaultValue)];
      return (
        <MultiSelectDropdown
          options={options.map((option) => ({ value: option.id, label: option.label }))}
          values={values}
          onChange={(next) => onChange(next.length ? next : undefined)}
          placeholder="不设置默认值"
          disabled={disabled}
          chips
          searchable
          searchPlaceholder="搜索默认选项…"
          renderOptionAction={field.kind === 'option' ? renderOptionAction : undefined}
        />
      );
    }
    return (
      <SelectDropdown
        ariaLabel={label}
        disabled={disabled}
        flat
        value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
        options={[
          { value: '', label: '不设置默认值', muted: true },
          ...options.map((option) => ({ value: option.id, label: option.label })),
        ]}
        onChange={(value) => onChange(value || undefined)}
        renderOptionAction={field.kind === 'option' ? renderOptionAction : undefined}
      />
    );
  }
  if (field.kind === 'bool') {
    return (
      <SelectDropdown
        ariaLabel={label}
        disabled={disabled}
        flat
        value={typeof field.defaultValue === 'boolean' ? String(field.defaultValue) : ''}
        options={[
          { value: '', label: '不设置默认值', muted: true },
          { value: 'true', label: '默认勾选' },
          { value: 'false', label: '默认不勾选' },
        ]}
        onChange={(value) => onChange(value === '' ? undefined : value === 'true' ? true : false)}
      />
    );
  }
  const value =
    field.defaultValue === undefined || Array.isArray(field.defaultValue)
      ? ''
      : String(field.defaultValue);
  return (
    <input
      aria-label={label}
      disabled={disabled}
      inputMode={field.kind === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value || undefined)}
      placeholder={
        field.kind === 'number'
          ? '不设置默认值；可填写数字'
          : field.kind === 'reference'
            ? '不设置默认值；可填写关联记录 ID'
            : '不设置默认值'
      }
      maxLength={30000}
    />
  );
}

export default function DefectSubmitEntry({ initialCreate = false }: { initialCreate?: boolean }) {
  const [rules, setRules] = useState<DefectTemplate[]>([]);
  const [deleting, setDeleting] = useState<DefectTemplate | null>(null);
  const [renamingOption, setRenamingOption] = useState<OptionTarget | null>(null);
  const [deletingOption, setDeletingOption] = useState<OptionTarget | null>(null);
  const [optionError, setOptionError] = useState('');
  const [cardIterationBusy, setCardIterationBusy] = useState('');
  const [cardRenamingIteration, setCardRenamingIteration] = useState<{
    entry: DefectTemplate;
    label: string;
  } | null>(null);
  const [cardDeletingIteration, setCardDeletingIteration] = useState<{
    entry: DefectTemplate;
    label: string;
  } | null>(null);
  const [cardIterationError, setCardIterationError] = useState('');
  const [query, setQuery] = useState('');
  const [closing, setClosing] = useState(false);
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const [sheets, setSheets] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hydratedRule = useRef('');
  useEffect(() => {
    let cancelled = false;
    void request('/templates')
      .then((data) => {
        if (!cancelled) {
          setRules(data.templates);
          if (initialCreate) setEditor(emptyEditor());
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialCreate]);
  const editorOpen = editor !== null;
  const editorId = editor?.id || '';
  const editorUrl = editor?.url || '';
  const editorSheetId = editor?.sheetId || '';
  useEffect(() => {
    if (!editorOpen) return;
    nameRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [editorOpen]); // Focus only when opening an editor.
  useEffect(() => {
    if (!editorId || !editorUrl.trim() || !editorSheetId) return;
    const key = editorId + ':' + editorSheetId;
    if (hydratedRule.current === key) return;
    hydratedRule.current = key;
    let cancelled = false;
    setIdentifying(true);
    void request('/inspect', { url: editorUrl, sheetId: editorSheetId })
      .then((result) => {
        if (cancelled || result.target.platform !== 'tencent') return;
        const inspected = result as InspectionResult;
        writeInspectionCache(inspectionKey(editorId, editorUrl, inspected.sheetId), inspected);
        setSheets(result.sheets);
        const fields: LinkField[] = result.fields;
        setEditor((previous) => {
          if (!previous || previous.id !== editorId) return previous;
          const nextFields = mergeRemoteFieldOptions(previous.fields, fields);
          return {
            ...previous,
            sheetId: result.sheetId || previous.sheetId,
            iterations: mergeIterationLabels(previous.iterations, previous.iteration),
            fields: applyIterationToFields(nextFields, previous.iteration),
          };
        });
      })
      .catch(() => {
        if (!cancelled)
          setNotice('字段选项暂未读取，可点击「识别字段」重试，或直接手动填写默认值。');
      })
      .finally(() => {
        if (!cancelled) setIdentifying(false);
      });
    return () => {
      cancelled = true;
      setIdentifying(false);
    };
  }, [editorId, editorOpen, editorSheetId, editorUrl]);
  useEffect(() => {
    if (!closing) return;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    const timer = window.setTimeout(() => {
      setEditor(null);
      setClosing(false);
      returnFocus.current?.focus();
    }, duration);
    return () => window.clearTimeout(timer);
  }, [closing]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function open(entry?: DefectTemplate) {
    returnFocus.current = document.activeElement as HTMLElement;
    setError('');
    setNotice('');
    setRenamingOption(null);
    setDeletingOption(null);
    setOptionError('');
    setClosing(false);
    setIdentifying(false);
    const cached = entry
      ? readInspectionCache(
          inspectionKey(entry.id, entry.config.target.url, entry.config.target.sheetId || ''),
        )
      : undefined;
    hydratedRule.current = entry && cached ? entry.id + ':' + cached.sheetId : '';
    setSheets(cached?.sheets || []);
    if (entry) {
      const iteration = entry.config.iteration?.trim() || '';
      const fields = mergeRemoteFieldOptions(
        entry.config.mapping.map((field) => ({
          ...field,
          options: visibleOptions(field),
          source:
            field.source || (entry.config.target.platform === 'tencent' ? 'remote' : 'manual'),
          rule: field.rule || '',
        })),
        cached?.fields || [],
      );
      setEditor({
        id: entry.id,
        name: entry.name,
        url: entry.config.target.url,
        sheetId: entry.config.target.sheetId || '',
        template: entry.config.template,
        iterations: mergeIterationLabels(entry.config.iterations || [], iteration),
        iteration,
        fields: applyIterationToFields(fields, iteration),
      });
    } else {
      setEditor(emptyEditor());
    }
  }
  function close() {
    if (busy || closing) return;
    setIdentifying(false);
    setRenamingOption(null);
    setDeletingOption(null);
    setOptionError('');
    setClosing(true);
    setError('');
  }
  function patchField(index: number, patch: Partial<FieldRule>) {
    setEditor(
      (previous) =>
        previous && {
          ...previous,
          fields: previous.fields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
        },
    );
  }
  function renameOption(target: OptionTarget, label: string) {
    const trimmed = label.trim();
    const field = editor?.fields.find((item) => item.id === target.fieldId);
    if (!trimmed || !field) return;
    if (
      visibleOptions(field).some(
        (option) => option.id !== target.optionId && option.label === trimmed,
      )
    ) {
      setOptionError('同一字段中已有同名选项');
      return;
    }
    setEditor(
      (previous) =>
        previous && {
          ...previous,
          fields: previous.fields.map((field) =>
            field.id === target.fieldId
              ? {
                  ...field,
                  options: visibleOptions(field).map((option) =>
                    option.id === target.optionId ? { ...option, label: trimmed } : option,
                  ),
                  optionLabels: { ...field.optionLabels, [target.optionId]: trimmed },
                }
              : field,
          ),
        },
    );
    setRenamingOption(null);
    setOptionError('');
  }
  function removeOption(target: OptionTarget) {
    setEditor(
      (previous) =>
        previous && {
          ...previous,
          fields: previous.fields.map((field) => {
            if (field.id !== target.fieldId) return field;
            const defaultValue = Array.isArray(field.defaultValue)
              ? field.defaultValue.filter((id) => id !== target.optionId)
              : field.defaultValue === target.optionId
                ? undefined
                : field.defaultValue;
            const optionLabels = { ...field.optionLabels };
            delete optionLabels[target.optionId];
            const manual = field.source === 'manual';
            const hiddenOptions = field.hiddenOptions?.filter((id) => id !== target.optionId);
            return {
              ...field,
              options: visibleOptions(field).filter((option) => option.id !== target.optionId),
              optionLabels,
              hiddenOptions: manual
                ? hiddenOptions?.length
                  ? hiddenOptions
                  : undefined
                : [...new Set([...(field.hiddenOptions || []), target.optionId])],
              defaultValue:
                Array.isArray(defaultValue) && !defaultValue.length ? undefined : defaultValue,
            };
          }),
        },
    );
    setDeletingOption(null);
  }
  function clearDefaultValue(index: number) {
    patchField(index, { defaultValue: undefined });
    requestAnimationFrame(() => {
      editorRef.current
        ?.querySelector<HTMLElement>('[data-default-value-index="' + index + '"]')
        ?.querySelector<HTMLElement>(
          '.dr-default-value-control button, .dr-default-value-control input',
        )
        ?.focus();
    });
  }
  function openDefaultValue(index: number) {
    requestAnimationFrame(() => {
      const control = editorRef.current
        ?.querySelector<HTMLElement>('[data-default-value-index="' + index + '"]')
        ?.querySelector<HTMLElement>(
          '.dr-default-value-control button, .dr-default-value-control input',
        );
      control?.focus();
      if (control instanceof HTMLButtonElement) {
        // Headless UI 的下拉依赖左键 pointerdown 切换；从旁边的编辑图标进入时补一次指针事件。
        control.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            pointerType: 'mouse',
            isPrimary: true,
          }),
        );
        control.click();
      }
    });
  }
  async function identify(sheetId = '') {
    if (!editor) return;
    const result = (await request('/inspect', { url: editor.url, sheetId })) as InspectionResult;
    writeInspectionCache(inspectionKey(editor.id || '', editor.url, result.sheetId), result);
    hydratedRule.current = (editor.id || '') + ':' + result.sheetId;
    setSheets(result.sheets);
    if (result.target.platform !== 'tencent') {
      setNotice('当前链接暂不支持自动识别，可以手动添加字段规则。');
      return;
    }
    if (!result.sheetId) {
      setNotice('请选择目标子表后读取字段。');
      return;
    }
    const incoming: LinkField[] = result.fields;
    setEditor((previous) => {
      if (!previous) return previous;
      const fields = [
        ...incoming
          .filter((field) => field.kind)
          .map((field) => {
            const existing = previous.fields.find(
              (item) =>
                (previous.sheetId === result.sheetId && item.id === field.id) ||
                (item.source === 'manual' && item.label === field.title),
            );
            return {
              id: field.id,
              label: existing?.label || field.title,
              required: existing?.required ?? true,
              rule: existing?.rule || '',
              defaultValue: existing?.defaultValue,
              source: 'remote',
              kind: field.kind,
              multiple: field.multiple === true,
              options: visibleOptions({
                id: field.id,
                label: field.title,
                required: false,
                options: field.options || [],
                optionLabels: existing?.optionLabels,
                hiddenOptions: existing?.hiddenOptions,
              }),
              optionLabels: existing?.optionLabels,
              hiddenOptions: existing?.hiddenOptions,
            };
          }),
        ...previous.fields.filter(
          (field) =>
            field.source === 'manual' &&
            !incoming.some((item) => item.id === field.id || item.title === field.label),
        ),
      ];
      const iterations = mergeIterationLabels(previous.iterations, previous.iteration);
      return {
        ...previous,
        sheetId: result.sheetId,
        iterations,
        fields: applyIterationToFields(fields, previous.iteration),
      };
    });
    setNotice(
      '已识别 ' +
        incoming.filter((field) => field.kind).length +
        ' 个可用字段，可逐项填写规则或移除不需要的字段。',
    );
  }
  async function persistCardIteration(
    entry: DefectTemplate,
    iterations: string[],
    iteration: string,
  ) {
    if (cardIterationBusy) return;
    setCardIterationBusy(entry.id);
    try {
      const result = await request('/rules/iteration', {
        id: entry.id,
        iterations,
        iteration,
      });
      setRules(result.templates);
      showToast(iteration ? '已更新当前迭代' : '已清除当前迭代', 'success');
    } catch (e) {
      showToast('更新当前迭代失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setCardIterationBusy('');
    }
  }
  function addCardIteration(entry: DefectTemplate, label: string) {
    const value = label.trim();
    const iterations = entry.config.iterations || [];
    if (!value) return;
    if (iterations.includes(value)) {
      showToast('已有同名当前迭代', 'error');
      return;
    }
    void persistCardIteration(entry, [...iterations, value], value);
  }
  function renameCardIteration(entry: DefectTemplate, previousLabel: string, label: string) {
    const value = label.trim();
    const iterations = entry.config.iterations || [];
    if (!value) return;
    if (iterations.some((item) => item !== previousLabel && item === value)) {
      setCardIterationError('已有同名当前迭代');
      return;
    }
    setCardIterationError('');
    void persistCardIteration(
      entry,
      iterations.map((item) => (item === previousLabel ? value : item)),
      entry.config.iteration === previousLabel ? value : entry.config.iteration || '',
    );
    setCardRenamingIteration(null);
  }
  function removeCardIteration(entry: DefectTemplate, label: string) {
    void persistCardIteration(
      entry,
      (entry.config.iterations || []).filter((item) => item !== label),
      entry.config.iteration === label ? '' : entry.config.iteration || '',
    );
    setCardDeletingIteration(null);
  }
  function renderCardIterationAction(
    entry: DefectTemplate,
    option: { value: string; label: string },
  ) {
    if (!option.value) return null;
    return (
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={'修改当前迭代 ' + option.label}
          className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-100 hover:text-stone-700 focus-visible:opacity-100 group-hover:opacity-100"
          disabled={cardIterationBusy === entry.id}
          onClick={() => {
            setCardIterationError('');
            setCardRenamingIteration({ entry, label: option.label });
          }}
        >
          <PmIcon name="pencil" size={13} />
        </button>
        <button
          type="button"
          aria-label={'删除当前迭代 ' + option.label}
          className="tw-icon-danger rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          disabled={cardIterationBusy === entry.id}
          onClick={() => setCardDeletingIteration({ entry, label: option.label })}
        >
          <PmIcon name="trash" size={13} />
        </button>
      </span>
    );
  }
  const visible = rules.filter((entry) =>
    (
      entry.name +
      ' ' +
      (entry.config.iteration || '') +
      entry.config.target.url +
      entry.config.mapping.map((field) => field.label).join(' ')
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="defect-rules">
      <header className="tw-pm-page-header dr-page-header">
        <span className="tw-pm-page-ico">
          <PmIcon name="file" size={18} />
        </span>
        <div>
          <h1 className="tw-page-title">缺陷规则</h1>
          <p className="tw-page-desc">维护字段填写规则，在工作台处理缺陷。</p>
        </div>
        <button
          className="tw-btn tw-btn-primary dr-button"
          disabled={loading || busy}
          onClick={() => open()}
        >
          <PmIcon name="plus" size={15} />
          新建规则
        </button>
      </header>
      {!editor && error && (
        <p role="alert" className="dr-alert">
          {error}
        </p>
      )}
      <div className="dr-toolbar">
        <span>{rules.length} 条规则</span>
        <label className="dr-search">
          <PmIcon name="search" size={15} />
          <input
            aria-label="搜索缺陷规则"
            placeholder="搜索规则、链接或字段…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {loading ? (
        <p role="status" className="dr-empty">
          正在加载规则…
        </p>
      ) : visible.length ? (
        <div className="dr-grid">
          {visible.map((entry) => (
            <article className="dr-card" key={entry.id}>
              <button
                type="button"
                className="dr-card-main"
                disabled={busy}
                aria-label={'编辑缺陷规则 ' + entry.name}
                onClick={() => open(entry)}
              >
                <span className="dr-card-heading">
                  <span className="dr-icon">
                    <PmIcon name="file" size={18} />
                  </span>
                  <span className="dr-card-title">
                    <OverflowHint text={entry.name} className="dr-rule-name" />
                    <span className="dr-card-subline">
                      <span className="dr-source">
                        {entry.config.target.platform === 'tencent' ||
                        /^https:\/\/docs.qq.com\//.test(entry.config.target.url)
                          ? '腾讯文档'
                          : '手动规则'}
                      </span>
                      <span className="dr-card-rule-count">
                        {entry.config.mapping.length} 个字段 ·{' '}
                        {entry.config.mapping.filter((field) => field.required).length} 个必填
                      </span>
                    </span>
                  </span>
                  <PmIcon name="chevronRight" size={16} />
                </span>
                <OverflowHint
                  text={
                    entry.config.target.sheetTitle ||
                    entry.config.target.url ||
                    '使用时提供目标链接'
                  }
                  className="dr-destination"
                />
                <OverflowHint
                  text={entry.config.template || '按字段规则整理缺陷信息'}
                  className="dr-rule-description"
                  clamp="y"
                />
                <FieldPills fields={entry.config.mapping} />
              </button>
              <footer>
                <span className="dr-card-meta">
                  <span className="dr-card-iteration-label">当前迭代</span>
                  <SearchableSelect
                    options={mergeIterationLabels(
                      entry.config.iterations || [],
                      entry.config.iteration || '',
                    ).map((label) => ({ value: label, label }))}
                    value={entry.config.iteration || ''}
                    onChange={(iteration) =>
                      void persistCardIteration(entry, entry.config.iterations || [], iteration)
                    }
                    placeholder="设置当前迭代"
                    disabled={busy || cardIterationBusy === entry.id}
                    emptyLabel="不设置当前迭代"
                    className="dr-card-iteration-select"
                    triggerClassName="dr-card-iteration"
                    menuMatchTrigger={false}
                    menuMinWidth={240}
                    showChevron
                    renderOptionAction={(option) => renderCardIterationAction(entry, option)}
                    onSearchCreate={(label) => addCardIteration(entry, label)}
                  />
                </span>
                <span className="dr-card-actions">
                  <button
                    className="dr-delete-button"
                    data-hint="删除规则"
                    disabled={busy}
                    aria-label={'删除规则 ' + entry.name}
                    onClick={() => setDeleting(entry)}
                  >
                    <PmIcon name="trash" size={15} />
                  </button>
                  <button
                    className="tw-btn tw-btn-ghost dr-button"
                    disabled={busy}
                    onClick={() => void run(() => openDefectWorkbench(entry))}
                  >
                    在工作台使用
                  </button>
                </span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="dr-empty">
          <span className="dr-empty-icon">
            <PmIcon name="file" size={28} />
          </span>
          <h2>{query ? '未找到匹配规则' : '创建第一条缺陷规则'}</h2>
          <p>
            {query
              ? '试试其他名称、链接或字段。'
              : '从目标链接读取字段，或手动定义字段和填写要求。'}
          </p>
          {!query && (
            <button className="tw-btn tw-btn-primary dr-button" onClick={() => open()}>
              新建规则
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除缺陷规则"
        message={
          deleting
            ? '确定删除规则「' +
              deleting.name +
              '」？此操作无法撤销。' +
              (error ? '\n' + error : '')
            : ''
        }
        danger
        confirmLabel={busy ? '正在删除…' : '删除规则'}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        onConfirm={() => {
          if (!deleting || busy) return;
          void run(async () => {
            const result = await request('/rules/delete', { id: deleting.id });
            setRules(result.templates);
            setDeleting(null);
          });
        }}
      />
      <NamePromptDialog
        open={cardRenamingIteration !== null}
        title="修改当前迭代"
        label="迭代名称"
        placeholder="例如 服务热线v1.12迭代"
        initialValue={cardRenamingIteration?.label ?? ''}
        confirmLabel="保存"
        cancelLabel="取消"
        error={cardIterationError}
        onClose={() => {
          setCardRenamingIteration(null);
          setCardIterationError('');
        }}
        onConfirm={(label) => {
          if (cardRenamingIteration)
            renameCardIteration(cardRenamingIteration.entry, cardRenamingIteration.label, label);
        }}
      />
      <ConfirmDialog
        open={cardDeletingIteration !== null}
        title="删除当前迭代"
        message={
          cardDeletingIteration
            ? '确定从规则「' +
              cardDeletingIteration.entry.name +
              '」中删除当前迭代「' +
              cardDeletingIteration.label +
              '」？目标缺陷表和其他规则不会被修改。'
            : ''
        }
        danger
        confirmLabel="删除迭代"
        onClose={() => setCardDeletingIteration(null)}
        onConfirm={() => {
          if (cardDeletingIteration)
            removeCardIteration(cardDeletingIteration.entry, cardDeletingIteration.label);
        }}
      />
      <NamePromptDialog
        open={renamingOption !== null}
        title="修改下拉选项"
        label="选项名称"
        placeholder="请输入选项名称"
        initialValue={renamingOption?.label ?? ''}
        confirmLabel="保存"
        cancelLabel="取消"
        error={optionError}
        onClose={() => {
          setRenamingOption(null);
          setOptionError('');
        }}
        onConfirm={(label) => {
          if (renamingOption) renameOption(renamingOption, label);
        }}
      />
      <ConfirmDialog
        open={deletingOption !== null}
        title={deletingOption?.source === 'manual' ? '删除选项' : '从当前规则删除选项'}
        message={
          deletingOption
            ? deletingOption.source === 'manual'
              ? '确定删除下拉选项「' + deletingOption.label + '」？该选项会从当前规则中删除。'
              : '确定删除下拉选项「' +
                deletingOption.label +
                '」？只会从当前缺陷规则中移除，不会修改腾讯文档字段或已有记录。'
            : ''
        }
        danger
        confirmLabel="删除选项"
        onClose={() => setDeletingOption(null)}
        onConfirm={() => {
          if (deletingOption) removeOption(deletingOption);
        }}
      />
      {editor &&
        createPortal(
          <div
            className={`defect-rules dr-overlay ${closing ? 'is-closing' : ''}`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={editorRef}
              className="dr-editor"
              role="dialog"
              aria-modal="true"
              aria-labelledby="dr-editor-title"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                }
                if (event.key === 'Tab') {
                  const nodes = editorRef.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
                  );
                  if (!nodes?.length) return;
                  const first = nodes[0],
                    last = nodes[nodes.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }}
            >
              <header>
                <div>
                  <h2 id="dr-editor-title">{editor.id ? '编辑缺陷规则' : '新建缺陷规则'}</h2>
                  <p>先定义目标与字段，再填写每个字段的处理要求。</p>
                </div>
                <button
                  className="dr-close"
                  aria-label="关闭规则编辑"
                  disabled={busy}
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div className="dr-editor-body">
                {error && (
                  <p role="alert" className="dr-alert">
                    {error}
                  </p>
                )}
                <label className="dr-label">
                  规则名称（必填）
                  <input
                    ref={nameRef}
                    disabled={busy}
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    placeholder="例如 服务热线缺陷登记"
                    maxLength={100}
                  />
                </label>
                <section className="dr-link-section">
                  <h3>目标链接</h3>
                  <div className="dr-inline">
                    <input
                      disabled={busy}
                      aria-label="目标链接"
                      value={editor.url}
                      onChange={(e) => {
                        setEditor({
                          ...editor,
                          url: e.target.value,
                          sheetId: '',
                          fields: editor.fields.map((field) =>
                            field.source === 'manual'
                              ? field
                              : {
                                  ...field,
                                  source: 'manual',
                                  kind: 'text',
                                  multiple: false,
                                  options: [],
                                  optionLabels: undefined,
                                  hiddenOptions: undefined,
                                  defaultValue:
                                    typeof field.defaultValue === 'string'
                                      ? field.defaultValue
                                      : undefined,
                                },
                          ),
                        });
                        setSheets([]);
                        setNotice('');
                      }}
                      placeholder="粘贴腾讯文档链接，也可稍后填写"
                    />
                    <button
                      className="tw-btn tw-btn-ghost dr-button"
                      disabled={busy || !editor.url.trim()}
                      onClick={() =>
                        void run(async () => {
                          setIdentifying(true);
                          try {
                            await identify(editor.sheetId);
                          } finally {
                            setIdentifying(false);
                          }
                        })
                      }
                    >
                      {identifying ? '正在识别…' : '识别字段'}
                    </button>
                  </div>
                  {sheets.length > 0 && (
                    <label className="dr-label">
                      目标子表
                      <SelectDropdown
                        ariaLabel="目标子表"
                        disabled={busy}
                        value={editor.sheetId}
                        options={sheets.map((sheet) => ({ value: sheet.id, label: sheet.title }))}
                        onChange={(value) =>
                          void run(async () => {
                            setIdentifying(true);
                            try {
                              await identify(value);
                            } finally {
                              setIdentifying(false);
                            }
                          })
                        }
                      />
                    </label>
                  )}
                  {!sheets.length && editor.sheetId && (
                    <p className="dr-hint">已绑定子表 · {editor.sheetId}</p>
                  )}
                  {notice && (
                    <p className="dr-hint" role="status">
                      {notice}
                    </p>
                  )}
                </section>
                <section>
                  <div className="dr-section-head">
                    <h3>
                      字段规则 <span>{editor.fields.length}</span>
                    </h3>
                    <button
                      className="tw-btn tw-btn-ghost dr-button"
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          fields: [
                            ...editor.fields,
                            {
                              id: 'manual_' + crypto.randomUUID(),
                              label: '',
                              required: true,
                              source: 'manual',
                              kind: 'text',
                              multiple: false,
                              options: [],
                              optionLabels: undefined,
                              hiddenOptions: undefined,
                              rule: '',
                              defaultValue: undefined,
                            },
                          ],
                        })
                      }
                    >
                      <PmIcon name="plus" size={14} />
                      添加字段
                    </button>
                  </div>
                  {!editor.fields.length && (
                    <p className="dr-fields-empty">尚未添加字段，可识别链接或手动添加。</p>
                  )}
                  <div className="dr-field-list">
                    {editor.fields.map((field, index) => {
                      const fieldHasDefault = hasDefaultValue(field);
                      const followsIteration = isIterationField(field);
                      return (
                        <div className="dr-field" key={field.id}>
                          <div className="dr-field-head">
                            <input
                              className="dr-field-name"
                              aria-label={'字段名称 ' + (index + 1)}
                              disabled={busy}
                              value={field.label}
                              onChange={(e) => patchField(index, { label: e.target.value })}
                              placeholder="字段名称，例如 缺陷标题"
                              maxLength={100}
                            />
                            <div className="dr-default-inline" data-default-value-index={index}>
                              <span
                                className="dr-default-label"
                                data-hint={
                                  followsIteration
                                    ? '该字段跟随规则级「当前迭代」，不需要单独设置默认值。'
                                    : '草稿未提供该字段时自动带入；单选和关联字段使用当前表的选项 ID。'
                                }
                              >
                                {followsIteration ? '取值' : '默认值'}
                              </span>
                              <div className="dr-default-value-control">
                                {followsIteration ? (
                                  <span className="dr-iteration-derived">
                                    {editor.iteration
                                      ? '取自当前迭代 · ' + editor.iteration
                                      : '请先设置当前迭代'}
                                  </span>
                                ) : (
                                  <DefaultValueEditor
                                    field={field}
                                    index={index}
                                    disabled={busy}
                                    onChange={(value) => patchField(index, { defaultValue: value })}
                                    onEditOption={(option) => {
                                      setOptionError('');
                                      setRenamingOption(option);
                                    }}
                                    onDeleteOption={setDeletingOption}
                                  />
                                )}
                              </div>
                              <span className="dr-default-value-actions">
                                {followsIteration ? null : fieldHasDefault ? (
                                  <>
                                    <button
                                      type="button"
                                      className="dr-default-icon dr-default-edit"
                                      disabled={busy}
                                      aria-label="修改默认值"
                                      data-hint="修改默认值"
                                      onClick={() => openDefaultValue(index)}
                                    >
                                      <PmIcon name="pencil" size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      className="dr-default-icon dr-default-remove"
                                      disabled={busy}
                                      aria-label="删除默认值"
                                      data-hint="删除默认值"
                                      onClick={() => clearDefaultValue(index)}
                                    >
                                      <PmIcon name="trash" size={14} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="dr-default-icon dr-default-edit"
                                    disabled={busy}
                                    aria-label="添加默认值"
                                    data-hint="添加默认值"
                                    onClick={() => openDefaultValue(index)}
                                  >
                                    <PmIcon name="plus" size={13} />
                                  </button>
                                )}
                              </span>
                            </div>
                            <span className="dr-source">
                              {field.source === 'remote' ? '链接识别' : '手动添加'}
                            </span>
                            <label className="dr-required">
                              <input
                                type="checkbox"
                                disabled={busy}
                                checked={field.required}
                                onChange={(e) => patchField(index, { required: e.target.checked })}
                              />
                              必填
                            </label>
                            <button
                              disabled={busy}
                              className="dr-remove"
                              aria-label={'移除字段 ' + (field.label || index + 1)}
                              onClick={() =>
                                setEditor({
                                  ...editor,
                                  fields: editor.fields.filter((_, i) => i !== index),
                                })
                              }
                            >
                              ×
                            </button>
                          </div>
                          <textarea
                            aria-label={'填写规则 ' + (field.label || index + 1)}
                            disabled={busy}
                            rows={2}
                            value={field.rule || ''}
                            onChange={(e) => patchField(index, { rule: e.target.value })}
                            placeholder="填写口径、取值来源或缺失时的处理方式…"
                            maxLength={6000}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
                <label className="dr-label">
                  通用规则{' '}
                  <textarea
                    disabled={busy}
                    rows={3}
                    value={editor.template}
                    onChange={(e) => setEditor({ ...editor, template: e.target.value })}
                    placeholder="适用于所有字段的处理要求，例如仅更新用户指定的字段。"
                    maxLength={12000}
                  />
                </label>
              </div>
              <footer>
                <button className="tw-btn tw-btn-ghost dr-button" disabled={busy} onClick={close}>
                  取消
                </button>
                <button
                  className="tw-btn tw-btn-primary dr-button"
                  disabled={
                    busy ||
                    !editor.name.trim() ||
                    !editor.fields.length ||
                    editor.fields.some((field) => !field.label.trim())
                  }
                  onClick={() =>
                    void run(async () => {
                      await request('/rules/save', {
                        id: editor.id,
                        name: editor.name,
                        url: editor.url,
                        sheetId: editor.sheetId,
                        template: editor.template,
                        iterations: editor.iterations,
                        iteration: editor.iteration,
                        mapping: editor.fields,
                      });
                      setRules((await request('/templates')).templates);
                      showToast(editor.id ? '已保存缺陷规则' : '已新建缺陷规则', 'success');
                      setClosing(true);
                    })
                  }
                >
                  {busy ? '正在处理…' : '保存规则'}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
