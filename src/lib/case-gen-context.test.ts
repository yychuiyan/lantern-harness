import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BusinessMapStore, BusinessSystem } from './business-map';
import {
  buildBusinessCaseContext,
  buildRequirementBreakdownContext,
  focusCaseGenContextForBatch,
  recommendBusinessSystem,
  recommendBusinessSystems,
  recommendRequirementBreakdown,
  refreshCaseGenContext,
} from './case-gen-context';
import type { RequirementBreakdownEntry } from './requirement-breakdown-library';

function breakdown(overrides: Partial<RequirementBreakdownEntry> = {}): RequirementBreakdownEntry {
  return {
    id: 'rbl_1',
    title: '上海12345工单系统V1.12_需求拆解.xmind',
    project: '上海12345工单系统',
    iteration: 'V1.12',
    sourcePath: '上海12345工单系统/上海12345工单系统V1.12_需求规格说明书.docx',
    sourceTitle: '上海12345工单系统V1.12_需求规格说明书.docx',
    sourceHash: '',
    analysisId: 'ra_1',
    analysisRevision: '',
    sourceExportAt: '',
    kind: 'generated',
    fileName: '上海12345工单系统V1.12_需求拆解.xmind',
    relativePath: '上海12345工单系统V1.12_需求拆解.xmind',
    localPath: '/tmp/上海12345工单系统V1.12_需求拆解.xmind',
    size: 1,
    mtime: '',
    fileMtime: '',
    exists: true,
    note: '已人工复核',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function system(overrides: Partial<BusinessSystem> = {}): BusinessSystem {
  return {
    id: 'sys_1',
    name: '上海12345工单系统',
    description: '受理、派单和归档',
    entryUrl: 'https://example.com',
    sourceDir: '/tmp/source',
    loginState: '.auth/private.json',
    docs: { requirements: true, knowledge: false, scope: '当前系统' },
    analysisScope: '全部菜单',
    status: 'draft',
    publishedRevision: 0,
    lastAnalysis: null,
    directories: [
      {
        id: 'dir_1',
        parentId: '',
        name: '工单受理',
        order: 0,
        source: 'manual',
        menuPath: ['工单受理'],
        entryUrl: '',
        evidence: [],
        createdAt: '',
        updatedAt: '',
      },
    ],
    functions: [
      {
        id: 'fn_1',
        code: 'F-001',
        name: '新建工单',
        directoryId: 'dir_1',
        order: 0,
        domain: '工单受理',
        module: '工单受理',
        status: '在用',
        purpose: '登记市民诉求',
        roles: ['受理人员'],
        entry: '/new',
        inputs: ['诉求内容'],
        outputs: ['工单号'],
        rules: ['匿名诉求不记录联系人'],
        writes: ['工单表'],
        exceptions: ['手机号格式错误时拦截'],
        implementation: [],
        evidence: [
          {
            id: 'ev_fn',
            type: 'page',
            title: '新建工单页面',
            ref: 'https://example.com/new?token=secret-token',
            note: '手机号校验失败时提示“格式错误”；password=fixture-secret；accessToken=fixture-token',
            confidence: 'high',
          },
        ],
        confidence: 'high',
        source: 'manual',
        confirmed: true,
        lockedFields: [],
        createdAt: '',
        updatedAt: '',
      },
    ],
    flows: [
      {
        id: 'flow_1',
        code: 'P1',
        name: '新建工单流程',
        result: '生成待派单工单',
        status: '健康',
        steps: [
          {
            id: 'step_1',
            n: 1,
            title: '登记并提交诉求',
            role: '受理人员',
            system: '工单系统',
            functionId: 'fn_1',
            input: '诉求内容',
            output: '工单号',
            next: '2',
            branch: '',
            branchBroken: false,
            manual: false,
            dependencies: [{ system: '统一认证', label: '校验受理人身份' }],
            evidence: [
              {
                id: 'ev_step',
                type: 'page',
                title: '提交结果',
                ref: 'https://example.com/result',
                note: '提交成功生成待派单工单号',
                confidence: 'high',
              },
            ],
          },
        ],
        evidence: [
          {
            id: 'ev_flow',
            type: 'doc',
            title: '工单流程说明',
            ref: '/docs/flow.md',
            note: '受理后进入派单池',
            confidence: 'high',
          },
        ],
        createdAt: '',
        updatedAt: '',
      },
    ],
    proposals: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('用例生成业务上下文', () => {
  it('优先按来源文件和产品版本匹配需求拆解 XMind', () => {
    const exact = breakdown();
    const other = breakdown({
      id: 'rbl_2',
      title: '政企通V1.16.0_需求拆解.xmind',
      sourceTitle: '政企通V1.16.0_需求文档.xlsx',
      project: '政企通',
      iteration: 'V1.16.0',
    });
    assert.equal(
      recommendRequirementBreakdown([other, exact], {
        sourceTitle: '上海12345工单系统V1.12_需求规格说明书.docx',
        sourcePath: '上海12345工单系统/上海12345工单系统V1.12_需求规格说明书.docx',
      })?.id,
      'rbl_1',
    );
  });

  it('业务系统按需求标题相似度匹配，唯一系统时可直接选中', () => {
    const target = system();
    assert.equal(
      recommendBusinessSystem([system({ id: 'sys_2', name: '政企通后台' }), target], {
        title: '上海12345工单系统V1.12_需求规格说明书.docx',
      })?.id,
      'sys_1',
    );
    assert.equal(
      recommendBusinessSystem([system({ id: 'only', name: '完全不相关' })], {})?.id,
      'only',
    );
  });

  it('跨系统需求按正文一次匹配多个业务系统', () => {
    const ticket = system();
    const identity = system({
      id: 'sys_auth',
      name: '统一认证',
      description: '登录、身份校验与令牌',
      directories: [],
      functions: [],
      flows: [],
    });
    const matched = recommendBusinessSystems([ticket, identity], {
      title: '市民诉求受理V1.12_需求规格说明书.docx',
      content:
        '受理人员登录统一认证后进入工单系统；校验通过后新建工单，并将受理结果回写统一认证审计日志。',
    });
    assert.deepEqual(matched.map((item) => item.id).sort(), ['sys_1', 'sys_auth']);
  });

  it('压缩业务地图时保留规则、IO、流程、跨系统依赖和证据摘录，并隐藏凭据', () => {
    const current = system();
    const store = { systems: [current] } as BusinessMapStore;
    const context = buildBusinessCaseContext(store, current.id);
    assert.ok(context);
    assert.match(context.block, /F-001 新建工单/);
    assert.match(context.block, /匿名诉求不记录联系人/);
    assert.match(context.block, /P1 新建工单流程/);
    assert.match(context.block, /登记并提交诉求/);
    assert.match(context.block, /统一认证·校验受理人身份/);
    assert.match(context.block, /提交成功生成待派单工单号/);
    assert.match(context.block, /手机号校验失败时提示/);
    assert.equal(context.block.includes('.auth/private.json'), false);
    assert.equal(context.block.includes('fixture-secret'), false);
    assert.equal(context.block.includes('fixture-token'), false);
    assert.equal(context.block.includes('secret-token'), false);
    assert.match(context.block, /password=\[已隐藏\]/);
    assert.match(context.block, /accessToken=\[已隐藏\]/);
    assert.equal(context.functionCount, 1);
    assert.equal(context.flowCount, 1);
  });

  it('需求拆解上下文保留最新树、项目和备注', () => {
    const context = buildRequirementBreakdownContext(breakdown(), {
      text: '- 上海12345工单系统V1.12\n  - 工单受理\n    - 新建工单',
      tree: [],
    });
    assert.ok(context);
    assert.match(context.block, /上海12345工单系统/);
    assert.match(context.block, /V1\.12/);
    assert.match(context.block, /已人工复核/);
    assert.match(context.block, /新建工单/);
  });

  it('发送前刷新会读取最新 XMind 和业务地图，失败时保留缓存并返回警告', async () => {
    const staleBreakdown = buildRequirementBreakdownContext(breakdown(), {
      text: '- 旧需求树',
      tree: [],
    });
    const staleBusiness = buildBusinessCaseContext(
      { systems: [system()] } as BusinessMapStore,
      'sys_1',
    );
    const refreshed = await refreshCaseGenContext(
      {
        requirementBreakdownContext: staleBreakdown || undefined,
        businessContext: staleBusiness || undefined,
      },
      {
        getRequirementBreakdown: async () => ({
          entry: breakdown({ title: '最新需求_需求拆解.xmind' }),
          content: { text: '- 最新需求树\n  - 新建工单', tree: [] },
        }),
        loadBusinessMap: async () =>
          ({
            systems: [
              system({
                functions: [
                  {
                    ...system().functions[0]!,
                    rules: ['最新规则：跨系统校验身份'],
                  },
                ],
              }),
            ],
          }) as BusinessMapStore,
      },
    );
    assert.match(refreshed.requirementBreakdownContext?.block || '', /最新需求树/);
    assert.match(refreshed.businessContext?.block || '', /最新规则：跨系统校验身份/);
    assert.deepEqual(refreshed.warnings, []);

    const fallback = await refreshCaseGenContext(
      {
        requirementBreakdownContext: staleBreakdown || undefined,
        businessContext: staleBusiness || undefined,
      },
      {
        getRequirementBreakdown: async () => {
          throw new Error('文件已移动');
        },
        loadBusinessMap: async () => {
          throw new Error('本地服务不可用');
        },
      },
    );
    assert.match(fallback.requirementBreakdownContext?.block || '', /旧需求树/);
    assert.match(fallback.businessContext?.block || '', /匿名诉求不记录联系人/);
    assert.equal(fallback.warnings.length, 2);
  });

  it('发送前一次刷新多个业务系统，并且不把多系统压回单系统字段', async () => {
    const ticket = buildBusinessCaseContext({ systems: [system()] } as BusinessMapStore, 'sys_1')!;
    const auth = buildBusinessCaseContext(
      {
        systems: [
          system({
            id: 'sys_auth',
            name: '统一认证',
            description: '身份校验',
            directories: [],
            functions: [],
            flows: [],
          }),
        ],
      } as BusinessMapStore,
      'sys_auth',
    )!;
    const refreshed = await refreshCaseGenContext(
      { businessContexts: [ticket, auth] },
      {
        getRequirementBreakdown: async () => {
          throw new Error('not used');
        },
        loadBusinessMap: async () =>
          ({
            systems: [
              system({ functions: [{ ...system().functions[0]!, rules: ['最新工单规则'] }] }),
              system({
                id: 'sys_auth',
                name: '统一认证',
                description: '身份校验',
                directories: [],
                functions: [],
                flows: [],
              }),
            ],
          }) as BusinessMapStore,
      },
    );
    assert.equal(refreshed.businessContexts?.length, 2);
    assert.equal(refreshed.businessContext, undefined);
    assert.match(refreshed.businessContexts?.[0]?.block || '', /最新工单规则/);
    assert.match(refreshed.businessContexts?.[1]?.block || '', /统一认证/);
  });

  it('分批上下文按测试点选择相关业务分支，并保留依赖说明', () => {
    const base = system();
    const current = system({
      directories: [
        ...base.directories,
        {
          ...base.directories[0]!,
          id: 'dir_2',
          name: '工单归档',
        },
      ],
      functions: [
        base.functions[0]!,
        {
          ...base.functions[0]!,
          id: 'fn_2',
          code: 'F-002',
          name: '归档工单',
          directoryId: 'dir_2',
          purpose: '将办结工单归档',
          rules: ['归档后禁止再次派单'],
          evidence: [
            {
              id: 'ev_archive',
              type: 'page',
              title: '归档工单页面',
              ref: '/archive',
              note: '归档后生成档案编号',
              confidence: 'high',
            },
          ],
        },
      ],
      flows: [
        base.flows[0]!,
        {
          ...base.flows[0]!,
          id: 'flow_2',
          code: 'P2',
          name: '工单归档流程',
          steps: [
            {
              ...base.flows[0]!.steps[0]!,
              id: 'step_2',
              title: '执行归档',
              functionId: 'fn_2',
              dependencies: [{ system: '档案系统', label: '写入归档编号' }],
            },
          ],
        },
      ],
    });
    const business = buildBusinessCaseContext(
      { systems: [current] } as BusinessMapStore,
      current.id,
    );
    const requirement = buildRequirementBreakdownContext(breakdown(), {
      text: '- 工单系统\n  - 工单受理\n    - 新建工单\n  - 工单归档\n    - 归档工单',
      tree: [],
    });
    const first = focusCaseGenContextForBatch(
      requirement || undefined,
      business || undefined,
      '新建工单',
    );
    const second = focusCaseGenContextForBatch(
      requirement || undefined,
      business || undefined,
      '归档工单',
    );
    assert.match(first.businessContext?.block || '', /新建工单/);
    assert.equal(first.businessContext?.block.includes('F-002 归档工单'), false);
    assert.match(second.businessContext?.block || '', /F-002 归档工单/);
    assert.equal(second.businessContext?.block.includes('F-001 新建工单'), false);
    assert.match(second.businessContext?.block || '', /档案系统·写入归档编号/);
    assert.match(first.requirementBreakdownContext?.block || '', /新建工单/);
    assert.equal(first.requirementBreakdownContext?.block.includes('归档工单'), false);
    assert.match(second.requirementBreakdownContext?.block || '', /归档工单/);
  });
});
