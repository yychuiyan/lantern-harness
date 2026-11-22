import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefectService, parseDefectUrl } from '../../lh-plugins/lh-defect-submit.mjs';

test('识别智能表入口并限制凭据 URL', () => {
  assert.equal(parseDefectUrl('https://docs.qq.com/smartsheet/abc?tab=ss_test').fileId, 'abc');
  assert.equal(parseDefectUrl('https://example.com/bugs').platform, 'manual');
  assert.equal(parseDefectUrl('https://docs.qq.com/sheet/abc?view=test').fileId, 'abc');
  assert.throws(() => parseDefectUrl('https://user:pass@example.com/'));
});

test('草稿校验、回读核验与并发提交只创建一次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-submit-'));
  let writes = 0;
  let values: unknown[] = [];
  const call = async (name: string, args: unknown) => {
    let data: object = {};
    if (name.endsWith('list_tables'))
      data = { sheets: [{ sheet_id: 'ss_test', title: '测试缺陷' }] };
    if (name.endsWith('list_fields'))
      data = { fields: [{ field_id: 'title', field_title: '缺陷标题', field_type: 'text' }] };
    if (name.endsWith('add_records')) {
      writes++;
      values = (args as { records: { field_values: unknown[] }[] }).records[0].field_values;
      data = { records: [{ record_id: 'record_1' }] };
    }
    if (name.endsWith('list_records'))
      data = { records: [{ record_id: 'record_1', field_values: values }] };
    return { ok: true, isError: false, text: JSON.stringify(data) };
  };
  try {
    const service = createDefectService(root, call);
    const ctx = await service.configure({
      url: 'https://docs.qq.com/smartsheet/abc',
      sheetId: 'ss_test',
      mapping: [{ id: 'title', label: '标题', required: true }],
    });
    const empty = await service.saveDraft({ contextRevision: ctx.revision, values: {} });
    await assert.rejects(service.submit({ id: empty.id, revision: empty.revision }), /必填/);
    const draft = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '保存失败' },
    });
    await Promise.all([
      service.submit({ id: draft.id, revision: draft.revision }),
      service.submit({ id: draft.id, revision: draft.revision }),
    ]);
    assert.equal(writes, 1);
    assert.equal((await service.receipt(draft.id)).status, 'submitted');
    await service.submit({ id: draft.id, revision: draft.revision });
    assert.equal(writes, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('带填写规则、图片和可选附件字段的映射可以正常提交', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-rich-submit-'));
  let writes = 0;
  let values: unknown[] = [];
  const call = async (name: string, args: unknown) => {
    let data: object = {};
    if (name.endsWith('list_tables'))
      data = { sheets: [{ sheet_id: 'ss_test', title: '测试缺陷' }] };
    if (name.endsWith('list_fields'))
      data = {
        fields: [
          { field_id: 'title', field_title: '缺陷标题', field_type: 'text' },
          { field_id: 'shot', field_title: '缺陷截图', field_type: 'image' },
          { field_id: 'file', field_title: '缺陷附件', field_type: 'attachment' },
        ],
      };
    if (name.endsWith('add_records')) {
      writes++;
      values = (args as { records: { field_values: unknown[] }[] }).records[0].field_values;
      data = { records: [{ record_id: 'record_rich' }] };
    }
    if (name.endsWith('list_records'))
      data = { records: [{ record_id: 'record_rich', field_values: values }] };
    return { ok: true, isError: false, text: JSON.stringify(data) };
  };
  try {
    const service = createDefectService(root, call);
    const rule = await service.saveRule({
      name: '带规则的缺陷',
      url: 'https://docs.qq.com/smartsheet/abc',
      sheetId: 'ss_test',
      mapping: [
        {
          id: 'title',
          label: '缺陷标题',
          source: 'remote',
          required: true,
          kind: 'text',
          options: [],
          rule: '按模块和现象生成',
        },
        {
          id: 'shot',
          label: '缺陷截图',
          source: 'remote',
          required: false,
          kind: 'image',
          options: [],
          rule: '有截图时上传',
        },
        {
          id: 'file',
          label: '缺陷附件',
          source: 'remote',
          required: false,
          kind: 'attachment',
          options: [],
          rule: '没有附件时留空',
        },
      ],
    });
    assert.equal(rule.config.mapping[0].rule, '按模块和现象生成');
    assert.equal(rule.config.mapping[1].kind, 'image');
    assert.equal(rule.config.mapping[2].kind, 'attachment');
    const ctx = await service.context();
    const draft = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '规则字段提交成功', shot: ['image_1'] },
    });
    assert.deepEqual(draft.missing, []);
    assert.deepEqual(draft.fieldValues, [
      {
        field: '缺陷标题',
        text_value: { items: [{ type: 'text', text: '规则字段提交成功' }] },
      },
      { field: '缺陷截图', image_value: { items: [{ image_id: 'image_1' }] } },
    ]);
    assert.equal(
      (await service.submit({ id: draft.id, revision: draft.revision })).status,
      'submitted',
    );
    assert.equal(writes, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('写入超时保留待核验状态且不重复写入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-pending-'));
  let writes = 0;
  const service = createDefectService(root, async (name: string) => {
    if (name.endsWith('add_records')) {
      writes++;
      throw new Error('timeout');
    }
    return {
      ok: true,
      isError: false,
      text: JSON.stringify(
        name.endsWith('list_tables')
          ? { sheets: [{ sheet_id: 'ss_test', title: '测试' }] }
          : { fields: [{ field_id: 'title', field_title: '标题', field_type: 'text' }] },
      ),
    };
  });
  try {
    const ctx = await service.configure({
      url: 'https://docs.qq.com/smartsheet/abc',
      sheetId: 'ss_test',
      mapping: [{ id: 'title', required: true }],
    });
    const draft = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '超时测试' },
    });
    assert.equal(
      (await service.submit({ id: draft.id, revision: draft.revision })).status,
      'pending',
    );
    await service.submit({ id: draft.id, revision: draft.revision });
    assert.equal(writes, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('独立命名模板可切换，旧草稿不能写入新目标', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-templates-'));
  try {
    const service = createDefectService(root);
    const first = await service.configure({
      url: 'https://example.com/one',
      name: '产品一',
      mapping: [],
    });
    assert.equal(
      first.fields?.every((field) => field.required),
      true,
    );
    const draft = await service.saveDraft({
      contextRevision: first.revision,
      values: { draft_0: '标题' },
    });
    const firstId = service.templates().selectedId;
    await service.configure({ url: 'https://example.com/two', name: '产品二', mapping: [] });
    assert.equal(service.templates().templates.length, 2);
    const selected = await service.selectTemplate({ id: firstId });
    assert.equal(selected.target?.url, 'https://example.com/one');
    assert.equal(selected.revision, first.revision);
    assert.equal((await service.receipt(draft.id)).values.draft_0, '标题');
    await service.configure({
      url: 'https://example.com/new',
      name: '产品一更新',
      templateId: firstId,
      mapping: [],
    });
    assert.equal(service.templates().templates.length, 2);
    await assert.rejects(
      service.saveDraft({ contextRevision: first.revision, values: { draft_0: '旧上下文' } }),
      /已变更/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('手动字段规则可独立保存、编辑并进入上下文', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-rule-'));
  try {
    const service = createDefectService(root);
    const rule = await service.saveRule({
      name: '手动规则',
      mapping: [
        {
          id: 'manual_title',
          label: '缺陷标题',
          required: true,
          source: 'manual',
          rule: '按模块和现象生成',
        },
      ],
    });
    assert.equal(rule.config.mapping[0].rule, '按模块和现象生成');
    assert.equal((await service.context()).fields?.[0].label, '缺陷标题');
    await service.saveRule({
      id: rule.id,
      name: '已更新规则',
      url: 'https://example.com/bugs',
      mapping: [{ id: 'manual_title', label: '标题', source: 'manual', rule: '只写已验证现象' }],
    });
    assert.equal(service.templates().templates.length, 1);
    assert.equal(service.templates().templates[0].name, '已更新规则');
    await assert.rejects(
      service.saveRule({
        name: '重复字段',
        mapping: [
          { id: 'one', label: '标题', source: 'manual' },
          { id: 'two', label: '标题', source: 'manual' },
        ],
      }),
      /重复/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('链接识别字段保留填写规则，手动字段可同时保存', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-link-rule-'));
  const service = createDefectService(root, async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷' }] }
        : { fields: [{ field_id: 'title', field_title: '缺陷标题', field_type: 'text' }] },
    ),
  }));
  try {
    const rule = await service.saveRule({
      name: '链接规则',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        { id: 'title', label: '缺陷标题', source: 'remote', rule: '模块 + 现象' },
        { id: 'manual_note', label: '补充说明', source: 'manual', rule: '记录日志链接' },
      ],
    });
    assert.equal(rule.config.target.sheetId, 'ss_test');
    assert.equal(rule.config.mapping[0].source, 'remote');
    assert.equal((await service.context()).fields?.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧手动字段与真实图片/附件字段同名时自动迁移到真实字段', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-manual-migrate-'));
  const call = async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷管理' }] }
        : {
            fields: [
              { field_id: 'title', field_title: '缺陷标题', field_type: 'text' },
              { field_id: 'shot', field_title: '缺陷截图', field_type: 'image' },
              { field_id: 'file', field_title: '缺陷附件', field_type: 'attachment' },
            ],
          },
    ),
  });
  try {
    const service = createDefectService(root, call);
    const rule = await service.saveRule({
      name: '旧手动字段迁移',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        { id: 'title', label: '缺陷标题', source: 'remote', required: true },
        { id: 'manual_shot', label: '缺陷截图', source: 'manual', required: false },
        { id: 'manual_file', label: '缺陷附件', source: 'manual', required: false },
      ],
    });
    assert.deepEqual(
      rule.config.mapping.map((field) => ({
        id: field.id,
        kind: field.kind,
        source: field.source,
      })),
      [
        { id: 'title', kind: 'text', source: 'remote' },
        { id: 'shot', kind: 'image', source: 'remote' },
        { id: 'file', kind: 'attachment', source: 'remote' },
      ],
    );
    const ctx = await service.context();
    assert.deepEqual(
      ctx.fields?.map((field) => ({ id: field.id, kind: field.kind, source: field.source })),
      [
        { id: 'title', kind: 'text', source: 'remote' },
        { id: 'shot', kind: 'image', source: 'remote' },
        { id: 'file', kind: 'attachment', source: 'remote' },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('字段默认值独立保存，并在草稿缺值时自动带入', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-default-values-'));
  const call = async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷管理' }] }
        : {
            fields: [
              { field_id: 'title', field_title: '缺陷标题', field_type: 'text' },
              {
                field_id: 'severity',
                field_title: '严重程度',
                field_type: 'singleSelect',
                property_single_select: {
                  is_multiple: false,
                  options: [
                    { id: 'high', text: '高' },
                    { id: 'medium', text: '中' },
                  ],
                },
              },
              {
                field_id: 'owners',
                field_title: '经办人',
                field_type: 'select',
                property_select: {
                  is_multiple: true,
                  options: [
                    { id: 'zhang', text: '张豪举' },
                    { id: 'deng', text: '邓念念' },
                  ],
                },
              },
            ],
          },
    ),
  });
  try {
    const service = createDefectService(root, call);
    const rule = await service.saveRule({
      name: '默认值规则',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        {
          id: 'title',
          label: '缺陷标题',
          source: 'remote',
          defaultValue: '默认缺陷标题',
        },
        {
          id: 'severity',
          label: '严重程度',
          source: 'remote',
          defaultValue: 'high',
        },
        {
          id: 'owners',
          label: '经办人',
          source: 'remote',
          defaultValue: ['zhang', 'deng'],
        },
      ],
    });
    assert.equal(rule.config.mapping[0].defaultValue, '默认缺陷标题');
    assert.equal(rule.config.mapping[1].defaultValue, 'high');
    assert.deepEqual(rule.config.mapping[2].defaultValue, ['zhang', 'deng']);

    const ctx = await service.context();
    const draft = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '实际缺陷标题' },
    });
    assert.deepEqual(draft.values, {
      title: '实际缺陷标题',
      severity: 'high',
      owners: ['zhang', 'deng'],
    });
    const preview = draft.preview as Array<{ label: string; column: string; value: unknown }>;
    assert.deepEqual(
      preview.find((item) => item.column === '严重程度'),
      { label: '严重程度', column: '严重程度', value: '高' },
    );
    assert.equal(preview.find((item) => item.column === '经办人')?.value, '张豪举、邓念念');
    const overridden = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '另一个缺陷', severity: 'medium' },
    });
    assert.equal(overridden.values.severity, 'medium');
    const cleared = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '清空默认值', severity: '' },
    });
    assert.equal(cleared.values.severity, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('规则当前迭代仅使用手动列表并自动驱动迭代版本字段', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-rule-iteration-'));
  const call = async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷管理' }] }
        : {
            fields: [
              { field_id: 'title', field_title: '缺陷标题', field_type: 'text' },
              {
                field_id: 'iteration',
                field_title: '迭代版本',
                field_type: 'singleSelect',
                property_single_select: {
                  is_multiple: false,
                  options: [
                    { id: 'iteration_old', text: '服务热线v1.11迭代' },
                    { id: 'iteration_new', text: '服务热线v1.12迭代' },
                  ],
                },
              },
            ],
          },
    ),
  });
  try {
    const service = createDefectService(root, call);
    const rule = await service.saveRule({
      name: '服务热线缺陷',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      iterations: ['服务热线v1.12迭代', '本地规划迭代'],
      iteration: '服务热线v1.12迭代',
      mapping: [
        { id: 'title', label: '缺陷标题', source: 'remote', required: true },
        { id: 'iteration', label: '迭代版本', source: 'remote', required: true },
      ],
    });
    assert.equal(rule.config.iteration, '服务热线v1.12迭代');
    assert.deepEqual(rule.config.iterations, ['服务热线v1.12迭代', '本地规划迭代']);

    const ctx = await service.context();
    assert.equal(ctx.iteration, '服务热线v1.12迭代');
    assert.deepEqual(ctx.iterations, rule.config.iterations);
    const iteration = ctx.fields?.find((field) => field.label === '迭代版本');
    assert.equal(iteration?.defaultValue, 'iteration_new');
    assert.match(String(iteration?.rule), /服务热线v1\.12迭代/);

    const draft = await service.saveDraft({
      contextRevision: ctx.revision,
      values: { title: '提交失败' },
    });
    assert.equal(draft.values.iteration, 'iteration_new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('卡片可直接更新当前迭代且不改变当前选中规则', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-card-iteration-'));
  try {
    const service = createDefectService(root);
    const first = await service.saveRule({
      name: '规则一',
      iterations: ['服务热线v1.12迭代'],
      iteration: '服务热线v1.12迭代',
      mapping: [{ id: 'manual_title', label: '缺陷标题', source: 'manual' }],
    });
    const second = await service.saveRule({
      name: '规则二',
      iterations: ['运管系统v1.10.0迭代'],
      iteration: '运管系统v1.10.0迭代',
      mapping: [{ id: 'manual_title_2', label: '缺陷标题', source: 'manual' }],
    });
    assert.equal(service.templates().selectedId, second.id);

    const result = service.updateRuleIteration({
      id: first.id,
      iterations: ['服务热线v1.12迭代', '服务热线v1.13迭代'],
      iteration: '服务热线v1.13迭代',
    });
    assert.equal(result.selectedId, second.id);
    const updated = result.templates.find((item: { id: string }) => item.id === first.id);
    assert.equal(updated.config.iteration, '服务热线v1.13迭代');
    assert.deepEqual(updated.config.iterations, ['服务热线v1.12迭代', '服务热线v1.13迭代']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('默认值可删除，选项默认值必须来自当前字段选项', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-default-delete-'));
  const call = async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷管理' }] }
        : {
            fields: [
              {
                field_id: 'priority',
                field_title: '优先级',
                field_type: 'singleSelect',
                property_single_select: {
                  is_multiple: false,
                  options: [{ id: 'p1', text: 'P1' }],
                },
              },
            ],
          },
    ),
  });
  try {
    const service = createDefectService(root, call);
    await assert.rejects(
      service.saveRule({
        name: '非法默认值',
        url: 'https://docs.qq.com/smartsheet/demo',
        sheetId: 'ss_test',
        mapping: [
          {
            id: 'priority',
            label: '优先级',
            source: 'remote',
            defaultValue: 'missing',
          },
        ],
      }),
      /默认值不在当前可用选项中/,
    );
    const rule = await service.saveRule({
      name: '可删除默认值',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        {
          id: 'priority',
          label: '优先级',
          source: 'remote',
          defaultValue: 'p1',
        },
      ],
    });
    await service.saveRule({
      id: rule.id,
      name: rule.name,
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        {
          id: 'priority',
          label: '优先级',
          source: 'remote',
        },
      ],
    });
    const ctx = await service.context();
    assert.equal(ctx.fields?.[0].defaultValue, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('下拉选项改名和隐藏只作用于当前规则，不回写腾讯文档', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-option-overrides-'));
  const calls: string[] = [];
  const call = async (name: string) => {
    calls.push(name);
    if (name.endsWith('update_fields')) throw new Error('不应修改腾讯文档字段');
    return {
      ok: true,
      isError: false,
      text: JSON.stringify(
        name.endsWith('list_tables')
          ? { sheets: [{ sheet_id: 'ss_test', title: '缺陷管理' }] }
          : {
              fields: [
                {
                  field_id: 'severity',
                  field_title: '严重程度',
                  field_type: 'singleSelect',
                  property_single_select: {
                    is_multiple: false,
                    options: [
                      { id: 'high', text: '高' },
                      { id: 'medium', text: '中' },
                      { id: 'low', text: '低' },
                    ],
                  },
                },
              ],
            },
      ),
    };
  };
  try {
    const service = createDefectService(root, call);
    const rule = await service.saveRule({
      name: '本地选项规则',
      url: 'https://docs.qq.com/smartsheet/demo',
      sheetId: 'ss_test',
      mapping: [
        {
          id: 'severity',
          label: '严重程度',
          source: 'remote',
          optionLabels: { high: '紧急' },
          hiddenOptions: ['low'],
          defaultValue: 'high',
        },
      ],
    });
    assert.deepEqual(rule.config.mapping[0].optionLabels, { high: '紧急' });
    assert.deepEqual(rule.config.mapping[0].hiddenOptions, ['low']);
    assert.equal(rule.config.mapping[0].options?.length, 3);

    const ctx = await service.context();
    assert.deepEqual(ctx.fields?.[0].options, [
      { id: 'high', label: '紧急' },
      { id: 'medium', label: '中' },
    ]);
    assert.equal(ctx.fields?.[0].defaultValue, 'high');
    assert.equal(
      calls.some((name) => name.endsWith('update_fields')),
      false,
    );

    await assert.rejects(
      service.saveRule({
        id: rule.id,
        name: rule.name,
        url: 'https://docs.qq.com/smartsheet/demo',
        sheetId: 'ss_test',
        mapping: [
          {
            id: 'severity',
            label: '严重程度',
            source: 'remote',
            hiddenOptions: ['low'],
            defaultValue: 'low',
          },
        ],
      }),
      /默认值不在当前可用选项中/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('手动字段的选项直接保存在规则中，删除时不产生远端隐藏记录', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-manual-options-'));
  try {
    const service = createDefectService(root);
    const rule = await service.saveRule({
      name: '手动选项规则',
      mapping: [
        {
          id: 'manual_module',
          label: '所属模块',
          source: 'manual',
          kind: 'option',
          options: [
            { id: 'login', label: '登录' },
            { id: 'billing', label: '计费' },
          ],
          defaultValue: 'login',
          required: true,
        },
      ],
    });
    assert.equal(rule.config.mapping[0].kind, 'option');
    assert.equal(rule.config.mapping[0].hiddenOptions, undefined);

    await service.saveRule({
      id: rule.id,
      name: rule.name,
      mapping: [
        {
          id: 'manual_module',
          label: '所属模块',
          source: 'manual',
          kind: 'option',
          options: [{ id: 'login', label: '登录' }],
          required: true,
        },
      ],
    });
    const ctx = await service.context();
    assert.deepEqual(ctx.fields?.[0].options, [{ id: 'login', label: '登录' }]);
    assert.equal(ctx.fields?.[0].kind, 'option');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('链接未指定子表时识别首个可见子表，链接指定子表时精确读取', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-inspect-'));
  const service = createDefectService(root, async (name: string) => ({
    ok: true,
    isError: false,
    text: JSON.stringify(
      name.endsWith('list_tables')
        ? {
            sheets: [
              { sheet_id: 'hidden', title: '隐藏', is_visible: false },
              { sheet_id: 'visible', title: '缺陷', is_visible: true },
            ],
          }
        : { fields: [{ field_id: 'title', field_title: '缺陷标题', field_type: 'text' }] },
    ),
  }));
  try {
    const result = await service.inspect({ url: 'https://docs.qq.com/sheet/demo', sheetId: '' });
    assert.equal(result.sheetId, 'visible');
    assert.equal(result.fields.length, 1);
    const linked = await service.inspect({
      url: 'https://docs.qq.com/sheet/demo?tab=hidden',
      sheetId: '',
    });
    assert.equal(linked.sheetId, 'hidden');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('删除规则更新选中项，删除最后一条不会恢复旧配置', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-delete-'));
  try {
    const service = createDefectService(root);
    const first = await service.saveRule({
      name: '第一条',
      mapping: [{ id: 'one', label: '标题', source: 'manual' }],
    });
    const second = await service.saveRule({
      name: '第二条',
      mapping: [{ id: 'two', label: '标题', source: 'manual' }],
    });
    const remaining = service.deleteRule({ id: second.id });
    assert.equal(remaining.selectedId, first.id);
    assert.equal((await service.context()).fields?.[0].id, 'one');
    service.deleteRule({ id: first.id });
    assert.deepEqual(service.templates(), { selectedId: '', templates: [] });
    assert.equal((await service.context()).configured, false);
    const restarted = createDefectService(root);
    assert.equal(restarted.templates().templates.length, 0);
    assert.throws(() => service.deleteRule({ id: first.id }), /不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
