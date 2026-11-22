import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { callMcpTool, mcpToolName } from '../builtin/session/mcp-client.mjs';
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { spaceLocalFile } from '../builtin/session/space-layout.mjs';
import { isPluginOnInSpace } from './plugin-prompts.mjs';

export const DEFECT_API = '/__tb_defect_submit';
const SERVER = 'tencent-docs';
const DEFAULT_TEMPLATE =
  '用可定位的功能和实际现象写标题。按材料整理环境、重现步骤、预期结果和实际结果。\n仅填写有依据的内容。缺少信息时留空，不能猜测负责人、迭代、定级或需求编号。';
const FALLBACK_FIELDS = ['缺陷标题', '测试环境', '重现步骤', '预期结果', '实际结果', '备注'];
const FIELD_TYPES = {
  text: 'text',
  singleSelect: 'option',
  select: 'option',
  reference: 'reference',
  twoWayLinkRecords: 'reference',
  image: 'image',
  attachment: 'attachment',
  number: 'number',
  checkbox: 'bool',
};
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const DRAFT_ID = /^[a-f0-9-]{36}$/;
const string = (value) => (typeof value === 'string' ? value.trim() : '');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defectPath = (root, file) => spaceLocalFile(root, 'defect-submit', file);

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function parseDefectUrl(raw) {
  let url;
  try {
    url = new URL(string(raw));
  } catch {
    fail('请输入完整的 HTTPS 缺陷入口地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail('请输入不含登录凭据的 HTTPS 缺陷入口地址');
  }
  const match = /^\/(?:smartsheet|sheet)\/([a-zA-Z0-9_-]{1,100})\/?$/.exec(url.pathname);
  const fileId = url.origin === 'https://docs.qq.com' && match ? match[1] : '';
  const tab = url.searchParams.get('tab') || '';
  return {
    url: fileId
      ? 'https://docs.qq.com/smartsheet/' + fileId + (ID.test(tab) ? '?tab=' + tab : '')
      : url.href,
    platform: fileId ? 'tencent' : 'manual',
    fileId,
    suggestedSheetId: ID.test(tab) ? tab : '',
  };
}

function tencentField(field) {
  const kind = Object.hasOwn(FIELD_TYPES, field.field_type) ? FIELD_TYPES[field.field_type] : '';
  const property =
    field.property_single_select ||
    field.property_select ||
    field.property_reference ||
    field.property_two_way_link_records ||
    {};
  return {
    id: field.field_id,
    title: field.field_title,
    kind,
    autoNumber: field.field_type === 'autoNumber',
    multiple: property.is_multiple === true || field.field_type === 'select',
    refSheetId: string(property.sub_id),
    refFieldId: string(property.field_id),
    options: (property.options || []).map(({ id, text }) => ({ id, label: text })),
  };
}

function recordText(field) {
  return field?.text_value?.items?.map((item) => item.text).join('') || '';
}

function canonicalValue(field) {
  for (const key of [
    'text_value',
    'option_value',
    'reference_value',
    'image_value',
    'number_value',
    'bool_value',
  ]) {
    if (!(key in field)) continue;
    const value = field[key];
    if (key === 'text_value') return recordText(field);
    if (key === 'option_value') return value.items.map((item) => item.id).sort();
    if (key === 'reference_value') return [...value.items].sort();
    if (key === 'image_value')
      return value.items
        .map((item) => item.image_id || item.image_url || '')
        .filter(Boolean)
        .sort();
    return value;
  }
}

function payload(field, value) {
  const target = { field: field.title };
  if (field.kind === 'text' && typeof value === 'string' && value.length <= 30000)
    return { ...target, text_value: { items: [{ type: 'text', text: value.trim() }] } };
  if (field.kind === 'number' && typeof value === 'number' && Number.isFinite(value))
    return { ...target, number_value: value };
  if (field.kind === 'bool' && typeof value === 'boolean') return { ...target, bool_value: value };
  if (field.kind === 'option' || field.kind === 'reference') {
    const ids = Array.isArray(value) ? [...new Set(value)] : [value];
    const options = new Set(field.options.map(({ id }) => id));
    if ((field.multiple || ids.length === 1) && ids.every((id) => options.has(id))) {
      return field.kind === 'option'
        ? { ...target, option_value: { items: ids.map((id) => ({ id })) } }
        : { ...target, reference_value: { items: ids } };
    }
  }
  if (field.kind === 'image') {
    const ids = [...new Set((Array.isArray(value) ? value : [value]).map(string).filter(Boolean))];
    if (ids.length && ids.every((id) => ID.test(id)))
      return { ...target, image_value: { items: ids.map((image_id) => ({ image_id })) } };
  }
  if (field.kind === 'attachment')
    fail('附件字段需先上传到目标平台并取得记录链接；当前规则不应把附件写成普通文本');
  fail('字段「' + field.label + '」的值无效，请选用当前表的可用值');
}

const empty = (value) =>
  value == null ||
  value === '' ||
  (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

function iterationField(fields) {
  return fields.find(
    (field) =>
      (field.label === '迭代版本' || field.title === '迭代版本') && field.kind === 'option',
  );
}

function normalizeIterations(raw, selected) {
  const iterations = [];
  const add = (value) => {
    const label = string(value).slice(0, 100);
    if (label && label !== '无' && !iterations.includes(label)) iterations.push(label);
  };
  for (const value of Array.isArray(raw) ? raw : []) add(value);
  const iteration = string(selected).slice(0, 100);
  if (iteration && !iterations.includes(iteration)) iterations.unshift(iteration);
  return {
    iterations,
    ...(iteration ? { iteration } : {}),
  };
}

function applyRuleIteration(fields, iteration) {
  const selected = string(iteration).slice(0, 100);
  if (!selected) return fields;
  return fields.map((field) => {
    if (!iterationField([field])) return field;
    const option = field.options.find((item) => item.label === selected);
    return {
      ...field,
      defaultValue: option?.id,
      rule: '使用当前规则当前迭代：' + selected + '，不要再次询问。',
      ...(option ? {} : { iterationOptionMissing: true }),
    };
  });
}

function normalizeDefaultValue(field, value, statusCode = 400) {
  if (empty(value)) return undefined;
  const label = field.label || field.title || '字段';
  if (field.kind === 'text') {
    if (typeof value === 'object') fail('字段「' + label + '」的默认值必须是文本', statusCode);
    return String(value).slice(0, 30000);
  }
  if (field.kind === 'number') {
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(number)) fail('字段「' + label + '」的默认值必须是有效数字', statusCode);
    return number;
  }
  if (field.kind === 'bool') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    fail('字段「' + label + '」的默认值必须是布尔值', statusCode);
  }
  if (field.kind === 'option' || field.kind === 'reference') {
    const ids = [...new Set((Array.isArray(value) ? value : [value]).map(string).filter(Boolean))];
    if (!ids.length) return undefined;
    if (!field.multiple && ids.length !== 1)
      fail('字段「' + label + '」只能设置一个默认值', statusCode);
    const options = field.options || [];
    if (options.length) {
      const available = new Set(options.map(({ id }) => id));
      const invalid = ids.find((id) => !available.has(id));
      if (invalid) fail('字段「' + label + '」的默认值不在当前可用选项中', statusCode);
    }
    return field.multiple ? ids : ids[0];
  }
  fail('字段「' + label + '」不支持默认值', statusCode);
}

/**
 * 选项改名 / 隐藏只属于当前缺陷规则，不回写腾讯文档。
 * 保存时仍以远端字段的 option ID 为边界，避免规则里混入伪造或已删除的选项。
 */
function resolveOptionOverrides(field, entry = {}) {
  const allOptions = Array.isArray(field.options) ? field.options : [];
  const available = new Set(allOptions.map(({ id }) => id));
  const hiddenOptions = [
    ...new Set(
      (Array.isArray(entry.hiddenOptions) ? entry.hiddenOptions : [])
        .map(string)
        .filter((id) => available.has(id)),
    ),
  ];
  const hidden = new Set(hiddenOptions);
  const optionLabels = {};
  if (
    entry.optionLabels &&
    typeof entry.optionLabels === 'object' &&
    !Array.isArray(entry.optionLabels)
  ) {
    for (const [id, value] of Object.entries(entry.optionLabels)) {
      const label = string(value).slice(0, 100);
      if (available.has(id) && label) optionLabels[id] = label;
    }
  }
  const options = allOptions
    .filter(({ id }) => !hidden.has(id))
    .map((option) => ({ ...option, label: optionLabels[option.id] || option.label }));
  return { allOptions, options, optionLabels, hiddenOptions };
}

function manualOptions(raw) {
  const seen = new Set();
  const labels = new Set();
  const options = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = string(item?.id);
    const label = string(item?.label).slice(0, 100);
    if (!ID.test(id) || !label || seen.has(id) || labels.has(label)) continue;
    seen.add(id);
    labels.add(label);
    options.push({ id, label });
  }
  return options;
}

function valuesWithDefaults(ctx, values) {
  const next = { ...values };
  for (const field of ctx.fields) {
    if (field.id in next || field.defaultValue === undefined) continue;
    next[field.id] = Array.isArray(field.defaultValue)
      ? [...field.defaultValue]
      : field.defaultValue;
  }
  return next;
}

function remoteFieldForEntry(schema, entry) {
  const byId = schema.find(({ id }) => id === entry.id);
  if (byId || entry.source !== 'manual') return byId;
  const byLabel = schema.filter(({ title, kind }) => kind && title === entry.label);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

export function createDefectService(root, call = callMcpTool) {
  const configFile = defectPath(root, 'target.json');

  async function remote(method, args) {
    const result = await call(mcpToolName(SERVER, 'smartsheet.' + method), args, root);
    if (!result.ok) fail('腾讯文档调用失败：' + (result.error || method), 502);
    let data;
    try {
      const parsed = JSON.parse(result.text);
      data = parsed.data ?? parsed;
    } catch {
      fail('腾讯文档返回了无法解析的结果', 502);
    }
    if (!data || data.error || (data.code && data.code !== 200))
      fail('腾讯文档未完成操作：' + (data?.error || method), 502);
    return data;
  }

  async function pages(method, args, key, limit = 50, max = 2000) {
    const items = [];
    let offset = 0;
    for (;;) {
      const result = await remote(method, { ...args, limit, offset });
      if (!Array.isArray(result[key])) fail('腾讯文档返回的数据缺少 ' + key, 502);
      items.push(...result[key]);
      if (!result.has_more || items.length >= max) return items;
      if (!Number.isInteger(result.next) || result.next <= offset)
        fail('腾讯文档分页位置无效', 502);
      offset = result.next;
    }
  }

  async function fields(fileId, sheetId) {
    const rows = await pages('list_fields', { file_id: fileId, sheet_id: sheetId }, 'fields');
    return rows.map(tencentField);
  }

  async function inspect({ url, sheetId }) {
    const target = parseDefectUrl(url);
    if (target.platform === 'manual') return { target, sheets: [], fields: [] };
    const data = await remote('list_tables', { file_id: target.fileId });
    if (!Array.isArray(data.sheets)) fail('腾讯文档未返回子表列表', 502);
    const sheets = data.sheets
      .filter((sheet) => ID.test(sheet.sheet_id))
      .map((sheet) => ({ id: sheet.sheet_id, title: sheet.title }));
    const preferred = sheetId || target.suggestedSheetId;
    const selected = preferred
      ? sheets.find(({ id }) => id === preferred)
      : sheets.find(
          ({ id }) => data.sheets.find((sheet) => sheet.sheet_id === id)?.is_visible !== false,
        );

    if (sheetId && !selected) fail('所选子表不在这个腾讯文档里');
    return {
      target,
      sheets,
      sheetId: selected?.id || '',
      fields: selected ? await fields(target.fileId, selected.id) : [],
    };
  }

  function selectedConfig() {
    const store = read(defectPath(root, 'templates.json'), null);
    return store
      ? store.templates.find((entry) => entry.id === store.selectedId)?.config || null
      : read(configFile, null);
  }

  async function context(config = selectedConfig()) {
    if (!config) return { configured: false };
    const { target, template, mapping } = config;
    if (target.platform === 'manual') {
      const fields = applyRuleIteration(
        mapping.map((field) => {
          const fieldType = {
            ...field,
            title: field.label,
            kind: field.kind === 'option' ? 'option' : 'text',
            multiple: field.multiple === true,
            options: field.kind === 'option' ? manualOptions(field.options) : [],
          };
          const optionState = resolveOptionOverrides(fieldType, field);
          const defaultValue = normalizeDefaultValue(
            { ...fieldType, options: optionState.options },
            field.defaultValue,
            409,
          );
          return {
            ...field,
            title: field.label,
            kind: fieldType.kind,
            multiple: fieldType.multiple,
            options: optionState.options,
            ...(Object.keys(optionState.optionLabels).length
              ? { optionLabels: optionState.optionLabels }
              : {}),
            ...(defaultValue === undefined ? {} : { defaultValue }),
          };
        }),
        config.iteration,
      );
      return {
        configured: true,
        target,
        template,
        fields,
        ...normalizeIterations(config.iterations, config.iteration),
        revision: hash([root, config]),
      };
    }
    const schema = await fields(target.fileId, target.sheetId);
    const resolved = mapping.map((entry) => {
      const remote = remoteFieldForEntry(schema, entry);
      const field =
        remote ||
        (entry.source === 'manual'
          ? { id: entry.id, title: entry.label, kind: 'text', options: [] }
          : undefined);
      if (
        !field?.kind ||
        (entry.source !== 'manual' &&
          schema.filter(({ title }) => title === field.title).length !== 1)
      )
        fail('映射字段「' + entry.label + '」已变更，请重新配置缺陷入口', 409);
      const optionState = resolveOptionOverrides(field, entry);
      const defaultValue = normalizeDefaultValue(
        { ...field, label: entry.label, options: optionState.options },
        entry.defaultValue,
        409,
      );
      return {
        ...field,
        ...entry,
        id: field.id,
        title: field.title,
        label: entry.label || field.title,
        source: remote ? 'remote' : entry.source,
        kind: field.kind,
        multiple: field.multiple,
        options: optionState.options,
        ...(Object.keys(optionState.optionLabels).length
          ? { optionLabels: optionState.optionLabels }
          : {}),
        ...(optionState.hiddenOptions.length ? { hiddenOptions: optionState.hiddenOptions } : {}),
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
    });
    const revision = hash([root, config, resolved]);
    await Promise.all(
      resolved
        .filter(({ kind }) => kind === 'reference')
        .map(async (field) => {
          if (!ID.test(field.refSheetId)) fail('关联字段「' + field.label + '」缺少目标子表', 409);
          const refFields = await fields(target.fileId, field.refSheetId);
          const primary = refFields.find(({ id }) => id === 'fumV40');
          const display = [
            ...new Set(
              [
                refFields.find(({ id }) => id === field.refFieldId),
                primary,
                ...refFields.filter(({ kind }) => kind === 'text').slice(0, 2),
              ]
                .filter(Boolean)
                .map(({ title }) => title),
            ),
          ];
          const options = await pages(
            'list_records',
            {
              file_id: target.fileId,
              sheet_id: field.refSheetId,
              ...(display.length ? { field_titles: display } : {}),
            },
            'records',
            30,
          );
          field.options = options
            .filter((row) => ID.test(row.record_id))
            .map((row) => ({
              id: row.record_id,
              label:
                display
                  .map((title) =>
                    recordText(row.field_values?.find((cell) => cell.field === title)),
                  )
                  .filter(Boolean)
                  .join(' / ') || row.record_id,
            }));
        }),
    );
    const fieldsWithIteration = applyRuleIteration(resolved, config.iteration);
    return {
      configured: true,
      target,
      template,
      fields: fieldsWithIteration,
      ...normalizeIterations(config.iterations, config.iteration),
      revision,
      numberField: schema.find(({ autoNumber }) => autoNumber)?.title,
    };
  }

  const templatesFile = defectPath(root, 'templates.json');

  function templates() {
    const stored = read(templatesFile, null);
    if (stored) return stored;
    const legacy = read(configFile, null);
    return legacy
      ? {
          selectedId: 'legacy',
          templates: [{ id: 'legacy', name: '默认缺陷规则', config: legacy }],
        }
      : { selectedId: '', templates: [] };
  }

  function deleteRule({ id }) {
    const store = templates();
    if (!store.templates.some((entry) => entry.id === id)) fail('规则已不存在，请刷新列表', 404);
    const remaining = store.templates.filter((entry) => entry.id !== id);
    const selectedId = store.selectedId === id ? remaining[0]?.id || '' : store.selectedId;
    save(templatesFile, { selectedId, templates: remaining });
    if (store.selectedId === id) {
      const next = remaining.find((entry) => entry.id === selectedId);
      if (next) save(configFile, next.config);
      else fs.rmSync(configFile, { force: true });
    }
    return { selectedId, templates: remaining };
  }

  async function selectTemplate({ id }) {
    const store = templates();
    const entry = store.templates.find((item) => item.id === id);
    if (!entry) fail('缺陷规则不存在', 404);
    const ctx = await context(entry.config);
    save(configFile, entry.config);
    save(templatesFile, { ...store, selectedId: id });
    return ctx;
  }

  async function configure({
    url,
    sheetId = '',
    template = '',
    mapping,
    templateId = '',
    name = '',
    iterations = [],
    iteration = '',
  }) {
    const inspected = await inspect({ url, sheetId });
    const selected = inspected.sheets.find(({ id }) => id === inspected.sheetId);
    const target =
      inspected.target.platform === 'tencent'
        ? { ...inspected.target, sheetId: selected?.id, sheetTitle: selected?.title }
        : inspected.target;
    if (target.platform === 'tencent' && !selected) fail('请先选择缺陷目标子表');
    if (selected)
      target.url = 'https://docs.qq.com/smartsheet/' + target.fileId + '?tab=' + selected.id;
    const candidates = selected
      ? inspected.fields.filter(
          (field) =>
            field.kind &&
            inspected.fields.filter(({ title }) => title === field.title).length === 1,
        )
      : FALLBACK_FIELDS.map((label, index) => ({ id: 'draft_' + index, title: label }));
    const entries = selected
      ? mapping
      : candidates.map((field) => ({
          id: field.id,
          label: field.title,
          required: true,
        }));
    if (!Array.isArray(entries) || !entries.length) fail('至少映射一个缺陷字段');
    const ids = new Set();
    const mapped = entries.map((entry) => {
      const field = candidates.find(({ id }) => id === entry?.id);
      if (!field || ids.has(field.id)) fail('存在重复或不支持的缺陷字段');
      ids.add(field.id);
      const defaultValue = normalizeDefaultValue(
        {
          ...field,
          label: entry.label,
          kind: field.kind || 'text',
          multiple: field.multiple === true,
          options: field.options || [],
        },
        entry.defaultValue,
      );
      return {
        id: field.id,
        label: string(entry.label).slice(0, 100) || field.title,
        required: entry.required === true,
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
    });
    if (!mapped.some(({ required }) => required)) fail('请至少标记一个必填字段');
    const next = {
      target,
      template: string(template).slice(0, 12000) || DEFAULT_TEMPLATE,
      mapping: mapped,
      ...normalizeIterations(iterations, iteration),
    };
    const result = await context(next);
    const store = templates();
    const id = templateId || randomUUID();
    if (templateId && !store.templates.some((entry) => entry.id === templateId))
      fail('缺陷规则已不存在，请重新加载', 409);
    const entry = { id, name: string(name).slice(0, 100) || '缺陷规则', config: next };
    store.templates = [...store.templates.filter((item) => item.id !== id), entry];
    store.selectedId = id;
    save(templatesFile, store);
    save(configFile, next);
    return result;
  }

  async function saveRule({
    id = '',
    name,
    url = '',
    sheetId = '',
    template = '',
    mapping,
    iterations = [],
    iteration = '',
  }) {
    if (!string(name)) fail('请填写规则名称');
    if (!Array.isArray(mapping) || !mapping.length || mapping.length > 100)
      fail('请添加 1 至 100 个字段规则');
    const store = templates();
    if (id && !store.templates.some((entry) => entry.id === id))
      fail('规则已不存在，请重新加载', 409);
    /** @type {{ platform: string, url: string, fileId: string, sheetId?: string, sheetTitle?: string, suggestedSheetId?: string }} */
    let target = url ? parseDefectUrl(url) : { platform: 'manual', url: '', fileId: '' };
    let schema = [];
    if (target.platform === 'tencent' && sheetId) {
      const inspected = await inspect({ url, sheetId });
      schema = inspected.fields;
      target = {
        ...target,
        sheetId,
        sheetTitle: inspected.sheets.find((sheet) => sheet.id === sheetId)?.title,
      };
      target.url = 'https://docs.qq.com/smartsheet/' + target.fileId + '?tab=' + sheetId;
    }
    const ids = new Set();
    const labels = new Set();
    const mapped = mapping.map((entry) => {
      const label = string(entry?.label).slice(0, 100);
      const fieldId = string(entry?.id);
      if (!label || !ID.test(fieldId) || ids.has(fieldId) || labels.has(label))
        fail('字段名称和标识不能为空或重复');
      ids.add(fieldId);
      labels.add(label);
      const remote = remoteFieldForEntry(schema, entry);
      const source = entry.source === 'manual' ? 'manual' : remote ? 'remote' : entry.source;
      if (entry.source !== 'manual' && !remote) fail('链接字段已变化，请重新识别或改用手动字段');
      const fieldType = remote || {
        id: fieldId,
        title: label,
        label,
        kind: entry.kind === 'option' ? 'option' : 'text',
        multiple: entry.multiple === true,
        options: entry.kind === 'option' ? manualOptions(entry.options) : [],
      };
      const optionState = resolveOptionOverrides(fieldType, entry);
      const defaultValue = normalizeDefaultValue(
        { ...fieldType, label, options: optionState.options },
        entry.defaultValue,
      );
      return {
        id: remote?.id || fieldId,
        label,
        required: entry.required === true,
        source: remote ? 'remote' : source,
        rule: string(entry.rule).slice(0, 6000),
        kind: fieldType.kind || 'text',
        multiple: fieldType.multiple === true,
        options: optionState.allOptions,
        ...(Object.keys(optionState.optionLabels).length
          ? { optionLabels: optionState.optionLabels }
          : {}),
        ...(source === 'remote' && optionState.hiddenOptions.length
          ? { hiddenOptions: optionState.hiddenOptions }
          : {}),
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
    });
    const config = {
      target,
      template: string(template).slice(0, 12000),
      mapping: mapped,
      ...normalizeIterations(iterations, iteration),
    };
    const entry = { id: id || randomUUID(), name: string(name).slice(0, 100), config };
    save(templatesFile, {
      selectedId: entry.id,
      templates: [...store.templates.filter((item) => item.id !== entry.id), entry],
    });
    save(configFile, config);
    return entry;
  }

  function updateRuleIteration({ id, iterations = [], iteration = '' }) {
    const store = templates();
    const entry = store.templates.find((item) => item.id === id);
    if (!entry) fail('规则已不存在，请刷新列表', 404);
    const state = normalizeIterations(iterations, iteration);
    const config = { ...entry.config, iterations: state.iterations };
    if (state.iteration) config.iteration = state.iteration;
    else delete config.iteration;
    const next = {
      ...store,
      templates: store.templates.map((item) => (item.id === id ? { ...item, config } : item)),
    };
    save(templatesFile, next);
    if (store.selectedId === id) save(configFile, config);
    return { selectedId: next.selectedId, templates: next.templates };
  }

  function draftFile(id) {
    if (!DRAFT_ID.test(id)) fail('缺陷草稿编号无效');
    return defectPath(root, id + '.json');
  }

  function getDraft(id) {
    const draft = read(draftFile(id), null);
    if (!draft) fail('当前数据空间中没有该缺陷草稿', 404);
    return draft;
  }

  function validate(ctx, values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail('草稿字段格式无效');
    const known = new Set(ctx.fields.map(({ id }) => id));
    if (Object.keys(values).some((id) => !known.has(id))) fail('草稿包含未映射字段');
    const missing = [];
    const fieldValues = [];
    for (const field of ctx.fields) {
      const value = values[field.id];
      if (empty(value)) {
        if (field.required) missing.push(field.label);
      } else {
        fieldValues.push(payload(field, value));
      }
    }
    return { missing, fieldValues };
  }

  async function saveDraft({ contextRevision, id = '', revision = '', values }) {
    const ctx = await context();
    if (!ctx.configured || ctx.revision !== contextRevision)
      fail('目标或模板已变更，请重新加载', 409);
    const effectiveValues = valuesWithDefaults(ctx, values);
    const { missing, fieldValues } = validate(ctx, effectiveValues);
    const key = id || randomUUID();
    const file = draftFile(key);
    const previous = id ? getDraft(id) : null;
    if (
      previous &&
      (previous.status !== 'draft' ||
        previous.revision !== revision ||
        previous.contextRevision !== contextRevision ||
        fs.existsSync(file + '.claim'))
    ) {
      fail('草稿已变更或已进入提交，请重新打开', 409);
    }
    const draft = {
      id: key,
      revision: randomUUID(),
      contextRevision,
      target: ctx.target,
      values: effectiveValues,
      missing,
      preview: ctx.fields.map((field) => ({
        label: field.label,
        column: field.title,
        value:
          field.options.length && !empty(effectiveValues[field.id])
            ? (Array.isArray(effectiveValues[field.id])
                ? effectiveValues[field.id]
                : [effectiveValues[field.id]]
              )
                .map((id) => field.options.find((option) => option.id === id)?.label)
                .join('、')
            : effectiveValues[field.id],
      })),
      status: 'draft',
      fieldValues,
    };
    save(file, draft);
    return draft;
  }

  async function verify(draft) {
    if (!draft.recordId || draft.status !== 'pending') return draft;
    const { fileId, sheetId } = draft.target;
    const checked = await remote('list_records', {
      file_id: fileId,
      sheet_id: sheetId,
      record_ids: [draft.recordId],
      field_titles: [
        ...draft.fieldValues.map(({ field }) => field),
        ...(draft.numberField ? [draft.numberField] : []),
      ],
    });
    const row = checked.records?.find(({ record_id }) => record_id === draft.recordId);
    const exact =
      row &&
      draft.fieldValues.every((expected) => {
        const actual = row.field_values?.find(({ field }) => field === expected.field);
        return (
          actual &&
          JSON.stringify(canonicalValue(expected)) === JSON.stringify(canonicalValue(actual))
        );
      });
    const number = row?.field_values?.find(
      ({ field }) => field === draft.numberField,
    )?.auto_number_value;
    if (!exact || (draft.numberField && !number?.text && !number?.seq)) return draft;
    const verified = {
      ...draft,
      status: 'submitted',
      number: number?.text || number?.seq || draft.recordId,
      verifiedAt: new Date().toISOString(),
    };
    save(draftFile(draft.id), verified);
    return verified;
  }

  async function submit({ id, revision }) {
    const draft = getDraft(id);
    if (draft.revision !== revision) fail('确认版本已失效，请重新预览草稿', 409);
    if (draft.status !== 'draft') return draft;
    const config = selectedConfig();
    const configFingerprint = hash(config);
    const ctx = await context(config);
    if (draft.target.platform !== 'tencent') fail('该入口仅支持导出缺陷草稿', 409);
    if (ctx.revision !== draft.contextRevision) fail('目标或字段映射已变更，请重新生成草稿', 409);
    const unresolvedManual = ctx.fields.filter(
      (field) => field.source === 'manual' && !empty(draft.values[field.id]),
    );
    if (unresolvedManual.length)
      fail(
        '手动字段需先核对目标字段：' + unresolvedManual.map((field) => field.label).join('、'),
        409,
      );
    const { missing, fieldValues } = validate(ctx, draft.values);
    if (missing.length) fail('请补齐必填字段：' + missing.join('、'));
    const file = draftFile(id);
    let claim;
    try {
      claim = fs.openSync(file + '.claim', 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return { ...getDraft(id), status: 'pending' };
      throw error;
    }
    fs.closeSync(claim);
    const latest = getDraft(id);
    if (
      latest.revision !== revision ||
      latest.status !== 'draft' ||
      hash(selectedConfig()) !== configFingerprint
    ) {
      fs.rmSync(file + '.claim');
      fail('提交前草稿或目标发生变化，请重新预览', 409);
    }
    let pending = {
      ...latest,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      numberField: ctx.numberField,
    };
    save(file, pending);
    try {
      const created = await remote('add_records', {
        file_id: draft.target.fileId,
        sheet_id: draft.target.sheetId,
        records: [{ field_values: fieldValues }],
      });
      const recordId = created.records?.[0]?.record_id ?? created.record_ids?.[0];
      if (!ID.test(recordId || '')) return pending;
      pending = { ...pending, recordId };
      save(file, pending);
      return await verify(pending);
    } catch {
      return pending;
    }
  }

  async function receipt(id) {
    const draft = getDraft(id);
    if (draft.status === 'draft' && fs.existsSync(draftFile(id) + '.claim'))
      return { ...draft, status: 'pending' };
    try {
      return await verify(draft);
    } catch {
      return draft;
    }
  }

  function drafts() {
    const directory = path.dirname(configFile);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => DRAFT_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map((name) => {
        const draft = getDraft(name.slice(0, -5));
        return draft.status === 'draft' && fs.existsSync(path.join(directory, name + '.claim'))
          ? { ...draft, status: 'pending' }
          : draft;
      })
      .reverse();
  }
  return {
    inspect,
    saveRule,
    updateRuleIteration,
    deleteRule,
    configure,
    context,
    saveDraft,
    submit,
    receipt,
    drafts,
    templates,
    selectTemplate,
  };
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    fail('请求必须使用 JSON', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) fail('缺陷请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('请求 JSON 格式无效');
  }
}

export function lhDefectSubmitPlugin() {
  return {
    name: 'lh-defect-submit',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const [pathname, params] = (req.url || '').split('?');
        if (pathname !== DEFECT_API && !pathname.startsWith(DEFECT_API + '/')) return next();
        const json = (status, value) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(value));
        };
        try {
          const root = getDataRoot();
          if (!isPluginOnInSpace('defectSubmit', root))
            fail('请先在当前空间的插件仓库开启「缺陷规则」', 403);
          const service = createDefectService(root);
          const action = pathname.slice(DEFECT_API.length);
          let data;
          if (req.method === 'GET') {
            if (action === '/context') data = await service.context();
            else if (action === '/templates') data = service.templates();
            else if (action === '/drafts') data = { drafts: service.drafts() };
            else if (action === '/receipt')
              data = await service.receipt(new URLSearchParams(params).get('id') || '');
          }
          if (req.method === 'POST') {
            if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
              fail('缺陷提交请求必须来自当前 Lantern 页面', 403);
            if (action === '/rules/delete') data = service.deleteRule(await body(req));
            else if (action === '/rules/save') data = await service.saveRule(await body(req));
            else if (action === '/rules/iteration')
              data = service.updateRuleIteration(await body(req));
            else if (action === '/select-template')
              data = await service.selectTemplate(await body(req));
            else if (action === '/inspect') data = await service.inspect(await body(req));
            else if (action === '/target') data = await service.configure(await body(req));
            else if (action === '/draft') data = await service.saveDraft(await body(req));
            else if (action === '/submit') data = await service.submit(await body(req));
          }
          if (data === undefined) fail('未知缺陷提交操作', 404);
          json(200, { ok: true, ...data });
        } catch (error) {
          json(error.statusCode || 500, { ok: false, error: error.message || String(error) });
        }
      });
    },
  };
}
