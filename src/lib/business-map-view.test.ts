import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSystem } from './business-map';
import {
  businessSystemSummary,
  businessDirectoryUsesDropdown,
  businessMenuDropPosition,
  businessPromotedFunctionIds,
  organizeBusinessDirectories,
  filterBusinessFunctions,
  filterBusinessSystems,
  businessEntryUrl,
  businessUpdatedLabel,
} from './business-map-view';

function fixture() {
  return normalizeSystem({
    id: 'orders',
    name: '工单系统',
    description: '受理与办理',
    status: 'draft',
    updatedAt: '2026-11-20T02:00:00Z',
    functions: [
      {
        id: 'intake',
        name: '来电登记',
        code: 'F-001',
        domain: '受理域',
        module: '来电受理',
        roles: ['话务员'],
        confirmed: true,
        evidence: [{ id: 'page', type: 'page', title: '受理页', ref: '/intake' }],
      },
      {
        id: 'handle',
        name: '工单办理',
        code: 'F-002',
        domain: '办理域',
        confirmed: false,
        evidence: [],
      },
      {
        id: 'query',
        name: '历史查询',
        code: 'F-003',
        domain: '受理域',
        confirmed: false,
        evidence: [{ id: 'doc', type: 'doc', title: '查询说明' }],
      },
    ],
    flows: [
      {
        id: 'flow',
        name: '受理闭环',
        steps: [
          { id: 'step', functionId: 'intake', title: '登记' },
          { id: 'other', functionId: 'intake', title: '核对' },
        ],
      },
    ],
    proposals: [
      { id: 'proposal', title: '待确认', status: 'pending' },
      { id: 'ignored', title: '已忽略', status: 'ignored' },
    ],
  });
}

describe('业务地图概览与导航口径', () => {
  it('功能目录按系统顺序组织，首页保持首位且仅父节点有子目录', () => {
    const directory = (id: string, name: string, order: number, parentId = '', menuPath = [name]) =>
      ({
        id,
        name,
        order,
        parentId,
        menuPath,
      }) as Parameters<typeof organizeBusinessDirectories>[0][number];
    const tree = organizeBusinessDirectories([
      directory('home', '首页', 2),
      directory('intake', '工单受理', 1),
      directory('new', '新建工单', 1, 'intake', ['工单受理', '新建工单']),
      directory('query', '工单查询', 0, 'intake', ['工单受理', '工单查询']),
      directory('dispatch', '派单处理', 0),
    ]);
    assert.deepEqual(
      tree.roots.map((item) => item.name),
      ['首页', '派单处理', '工单受理'],
    );
    assert.deepEqual(
      tree.children.get('intake')?.map((item) => item.name),
      ['工单查询', '新建工单'],
    );
    assert.equal(tree.children.get('home')?.length || 0, 0);
  });
  it('除首页外，有直属功能的目录都使用下拉', () => {
    const directory = (id: string, name: string) =>
      ({
        id,
        name,
        parentId: '',
        order: 0,
        menuPath: [name],
      }) as Parameters<typeof businessDirectoryUsesDropdown>[0];
    const fn = (name: string, directoryId: string) =>
      ({
        id: `${directoryId}_${name}`,
        name,
        directoryId,
      }) as Parameters<typeof businessDirectoryUsesDropdown>[2][number];
    const home = directory('home', '首页');
    const intake = directory('intake', '工单受理');
    const dispatch = directory('dispatch', '派单处理');
    const directories = [home, intake, dispatch];
    const functions = [
      fn('首页', 'home'),
      fn('新建工单', 'intake'),
      fn('派单处理', 'dispatch'),
      fn('派单查询', 'dispatch'),
    ];
    assert.equal(businessDirectoryUsesDropdown(home, directories, functions), false);
    assert.equal(businessDirectoryUsesDropdown(intake, directories, functions), true);
    assert.equal(businessDirectoryUsesDropdown(dispatch, directories, functions), true);
  });
  it('目录上半区、中心和下半区分别映射到前、内部、后', () => {
    assert.equal(businessMenuDropPosition('directory', 0.1), 'before');
    assert.equal(businessMenuDropPosition('directory', 0.5), 'inside');
    assert.equal(businessMenuDropPosition('directory', 0.9), 'after');
    assert.equal(businessMenuDropPosition('function', 0.5), 'after');
  });
  it('导航顺序早于所属目录的功能提升为根级菜单', () => {
    const directory = {
      id: 'intake',
      name: '工单受理',
      parentId: '',
      order: 0,
      menuPath: ['工单受理'],
    } as Parameters<typeof businessPromotedFunctionIds>[0][number];
    const query = {
      id: 'query',
      name: '工单查询',
      directoryId: 'intake',
    } as Parameters<typeof businessPromotedFunctionIds>[1][number];
    const promoted = businessPromotedFunctionIds(
      [directory],
      [query],
      [
        { label: '工单查询', order: 1 },
        { label: '工单受理', order: 4 },
      ],
    );
    assert.deepEqual([...promoted], ['query']);
  });
  it('手工拖到根级的功能保持原目录，同时提升为根级菜单', () => {
    const query = {
      id: 'query',
      name: '工单查询',
      directoryId: 'intake',
      menuRoot: true,
    } as Parameters<typeof businessPromotedFunctionIds>[1][number];
    const promoted = businessPromotedFunctionIds([], [query], []);
    assert.deepEqual([...promoted], ['query']);
    assert.equal(query.directoryId, 'intake');
  });
  it('覆盖率按有证据的功能计算，重复流程引用不重复计数', () => {
    const summary = businessSystemSummary(fixture());
    assert.equal(summary.withEvidence, 2);
    assert.equal(summary.evidencePercent, 67);
    assert.equal(summary.confirmed, 1);
    assert.equal(summary.unconfirmed, 2);
    assert.equal(summary.unlinked, 2);
    assert.equal(summary.pending, 1);
    assert.deepEqual(
      summary.domains.map((item) => [item.name, item.functions.length]),
      [
        ['受理域', 2],
        ['办理域', 1],
      ],
    );
  });
  it('空系统不生成 NaN 或虚假完成度', () => {
    const summary = businessSystemSummary(normalizeSystem({ name: '空系统' }));
    assert.equal(summary.evidencePercent, 0);
    assert.equal(summary.unlinked, 0);
    assert.equal(summary.domains.length, 0);
  });
  it('待完善项同时遵守业务域和关键词筛选', () => {
    const system = fixture();
    assert.deepEqual(
      filterBusinessFunctions(system, 'unconfirmed', '受理域').map((item) => item.id),
      ['query'],
    );
    assert.deepEqual(
      filterBusinessFunctions(system, 'no-evidence').map((item) => item.id),
      ['handle'],
    );
    assert.deepEqual(
      filterBusinessFunctions(system, 'unlinked', '全部', '历史').map((item) => item.id),
      ['query'],
    );
    assert.equal(filterBusinessFunctions(system, 'no-evidence', '受理域').length, 0);
  });
  it('支持功能编号与使用角色检索，无匹配返回空结果', () => {
    const system = fixture();
    assert.equal(filterBusinessFunctions(system, 'all', '全部', '  f-001  ')[0].id, 'intake');
    assert.equal(filterBusinessFunctions(system, 'all', '全部', '话务员')[0].id, 'intake');
    assert.equal(filterBusinessFunctions(system, 'all', '全部', '不存在').length, 0);
  });
});

describe('业务地图系统入口', () => {
  it('可按功能和业务域找到所属系统，状态筛选可叠加搜索', () => {
    const systems = [
      fixture(),
      normalizeSystem({ id: 'finance', name: '财务系统', status: 'published' }),
    ];
    assert.equal(filterBusinessSystems(systems, 'all', '历史查询', 'updated')[0].id, 'orders');
    assert.equal(filterBusinessSystems(systems, 'draft', '受理域', 'updated').length, 1);
    assert.equal(filterBusinessSystems(systems, 'published', '受理域', 'updated').length, 0);
    assert.equal(filterBusinessSystems(systems, 'pending', '', 'updated').length, 1);
  });
  it('按最近更新排序，不改变原始系统顺序', () => {
    const a = fixture();
    const b = normalizeSystem({ id: 'new', name: '新系统', updatedAt: '2026-11-21T00:00:00Z' });
    const systems = [a, b];
    assert.deepEqual(
      filterBusinessSystems(systems, 'all', '', 'updated').map((item) => item.id),
      ['new', 'orders'],
    );
    assert.deepEqual(
      systems.map((item) => item.id),
      ['orders', 'new'],
    );
  });
  it('仅为有效 HTTP 系统入口生成外链', () => {
    assert.equal(businessEntryUrl('https://example.com/path'), 'https://example.com/path');
    assert.equal(businessEntryUrl('javascript:alert(1)'), null);
    assert.equal(businessEntryUrl('/local/path'), null);
    assert.equal(businessEntryUrl(''), null);
  });
  it('更新时间按上海日期显示，缺失时间有明确回退', () => {
    assert.equal(businessUpdatedLabel('2026-11-20T23:00:00Z'), '11/21 更新');
    assert.equal(businessUpdatedLabel(''), '尚未更新');
  });
});
