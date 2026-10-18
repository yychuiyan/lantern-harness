import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildNavRenderList,
  DEFAULT_NAV_GROUPS,
  defaultNavOrder,
  moveNavOrder,
  normalizeNavGroups,
  reorderNavOrder,
  orderAfterRemove,
  orderAfterUpsert,
  removeNavGroup,
  addItemToGroup,
  removeItemFromGroup,
  orderAfterLeaveGroup,
  listChildGroups,
  orderAfterChildReorder,
  orderedChildGroups,
  upsertNavGroup,
  type NavMenuGroup,
} from './nav-menu';

/** 测试夹具：一个「文档库」分组（不再是内置默认值） */
const DOCS_GROUPS: NavMenuGroup[] = [
  { id: 'docs', name: '文档库', items: ['requirements', 'templates'] },
];

describe('normalizeNavGroups', () => {
  it('缺省时不预置分组', () => {
    assert.deepEqual(normalizeNavGroups(undefined), []);
    assert.deepEqual(DEFAULT_NAV_GROUPS, []);
  });

  it('空数组表示用户删光了分组', () => {
    assert.deepEqual(normalizeNavGroups([]), []);
  });

  it('同一菜单项只属于一个分组', () => {
    const next = normalizeNavGroups([
      { id: 'a', name: 'A', items: ['requirements', 'templates'] },
      { id: 'b', name: 'B', items: ['templates', 'cases'] },
    ]);
    assert.equal(next.length, 2);
    assert.deepEqual(next[0].items, ['requirements', 'templates']);
    assert.deepEqual(next[1].items, ['cases']);
  });
});

describe('upsertNavGroup / removeNavGroup', () => {
  it('新建分组会从其它组挪走条目', () => {
    const { groups: next, id } = upsertNavGroup(DOCS_GROUPS, {
      name: '文档库',
      items: ['requirements', 'templates'],
    });
    assert.ok(id);
    assert.equal(next.filter((g) => g.name === '文档库').length, 1);
    assert.equal(
      next.find((g) => g.id === 'docs'),
      undefined,
    );
  });

  it('删除分组后条目平铺到侧栏底部', () => {
    const groups = [
      { id: 'docs', name: '文档库', items: ['requirements' as const, 'templates' as const] },
    ];
    // 分组夹在中间：删除后组内项应落到末尾，而不是留在原位
    const order = ['item:cases', 'group:docs', 'item:prompts', 'item:knowledgeLib'];
    const next = removeNavGroup(groups, 'docs');
    const list = buildNavRenderList(next, orderAfterRemove(order, groups[0]!, next));
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'cases',
        'prompts',
        'knowledgeLib',
        'requirements',
        'templates',
        'dashboard',
        'tasks',
        'todos',
        'reports',
        'testStats',
        'caseExec',
      ],
    );
  });
});

describe('buildNavRenderList', () => {
  it('默认顺序：仪表盘 / 任务 / 待办 / 汇报 / 测试统计 / 用例执行统计 + 其它库 + 文档库分组', () => {
    const list = buildNavRenderList(DOCS_GROUPS);
    assert.equal(list[0].type, 'item');
    if (list[0].type === 'item') assert.equal(list[0].id, 'dashboard');
    if (list[1].type === 'item') assert.equal(list[1].id, 'tasks');
    assert.equal(list[9].type, 'group');
    if (list[9].type === 'group') {
      assert.equal(list[9].group.id, 'docs');
      assert.deepEqual(list[9].group.items, ['requirements', 'templates']);
    }
  });

  it('按 navOrder 重排顶层', () => {
    const list = buildNavRenderList(DOCS_GROUPS, [
      'group:docs',
      'item:cases',
      'item:prompts',
      'item:knowledgeLib',
    ]);
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'docs',
        'cases',
        'prompts',
        'knowledgeLib',
        'dashboard',
        'tasks',
        'todos',
        'reports',
        'testStats',
        'caseExec',
      ],
    );
  });
});

describe('nav order helpers', () => {
  it('创建分组时用条目原先位置插入组', () => {
    const empty: NavMenuGroup[] = [];
    const { groups, id } = upsertNavGroup(empty, {
      name: '文档库',
      items: ['requirements', 'templates'],
    });
    const order = orderAfterUpsert(
      ['item:cases', 'item:prompts', 'item:knowledgeLib', 'item:requirements', 'item:templates'],
      groups,
      id,
    );
    assert.deepEqual(order, [
      'item:cases',
      'item:prompts',
      'item:knowledgeLib',
      `group:${id}`,
      'item:dashboard',
      'item:tasks',
      'item:todos',
      'item:reports',
      'item:testStats',
      'item:caseExec',
    ]);
  });

  it('上移下移交换相邻项', () => {
    const order = defaultNavOrder(DOCS_GROUPS);
    const moved = moveNavOrder(order, 'item:cases', 1);
    assert.equal(moved[6], 'item:prompts');
    assert.equal(moved[7], 'item:cases');
  });

  it('把顶层项加入已有分组', () => {
    const next = addItemToGroup(DOCS_GROUPS, 'docs', 'cases');
    const docs = next.find((g) => g.id === 'docs');
    assert.deepEqual(docs?.items, ['requirements', 'templates', 'cases']);
  });

  it('取消分组后条目回到原组旁边', () => {
    const { groups, owner } = removeItemFromGroup(DOCS_GROUPS, 'templates');
    assert.ok(owner);
    const order = orderAfterLeaveGroup(defaultNavOrder(DOCS_GROUPS), 'templates', owner, groups);
    const list = buildNavRenderList(groups, order);
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'dashboard',
        'tasks',
        'todos',
        'reports',
        'testStats',
        'caseExec',
        'cases',
        'prompts',
        'knowledgeLib',
        'docs',
        'templates',
      ],
    );
    assert.deepEqual(groups.find((g) => g.id === 'docs')?.items, ['requirements']);
  });

  it('可在分组下创建子分组', () => {
    const { groups, id } = upsertNavGroup(DOCS_GROUPS, {
      name: '模板',
      items: ['templates'],
      parentId: 'docs',
    });
    const child = groups.find((g) => g.id === id);
    assert.equal(child?.parentId, 'docs');
    assert.deepEqual(groups.find((g) => g.id === 'docs')?.items, ['requirements']);
    assert.deepEqual(
      listChildGroups(groups, 'docs').map((g) => g.id),
      [id],
    );
    const list = buildNavRenderList(groups);
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'dashboard',
        'tasks',
        'todos',
        'reports',
        'testStats',
        'caseExec',
        'cases',
        'prompts',
        'knowledgeLib',
        'docs',
      ],
    );
  });

  it('删除子分组后条目回到父组', () => {
    const { groups, id } = upsertNavGroup(DOCS_GROUPS, {
      name: '模板',
      items: ['templates'],
      parentId: 'docs',
    });
    const next = removeNavGroup(groups, id);
    assert.equal(listChildGroups(next, 'docs').length, 0);
    assert.deepEqual(next.find((g) => g.id === 'docs')?.items, ['requirements', 'templates']);
  });

  it('拖拽把项插到目标位置', () => {
    const order = defaultNavOrder(DOCS_GROUPS);
    const moved = reorderNavOrder(order, 'item:cases', 'group:docs');
    assert.deepEqual(moved, [
      'item:dashboard',
      'item:tasks',
      'item:todos',
      'item:reports',
      'item:testStats',
      'item:caseExec',
      'item:prompts',
      'item:knowledgeLib',
      'group:docs',
      'item:cases',
    ]);
  });

  it('子分组顺序单独记录，不占侧栏顶层位置', () => {
    const groups: NavMenuGroup[] = [
      { id: 'g', name: '质量', items: ['requirements'] },
      { id: 'c1', name: '接口', items: ['templates'], parentId: 'g' },
      { id: 'c2', name: '功能', items: ['cases'], parentId: 'g' },
    ];
    const order = defaultNavOrder(groups);
    assert.deepEqual(
      orderedChildGroups(groups, 'g').map((g) => g.id),
      ['c1', 'c2'],
    );

    const next = orderAfterChildReorder(order, groups, 'g', ['c2', 'c1']);
    assert.deepEqual(
      orderedChildGroups(groups, 'g', next).map((g) => g.id),
      ['c2', 'c1'],
    );
    // 子分组 key 不能出现在顶层渲染结果里
    const list = buildNavRenderList(groups, next);
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'dashboard',
        'tasks',
        'todos',
        'reports',
        'testStats',
        'caseExec',
        'g',
        'prompts',
        'knowledgeLib',
      ],
    );
  });

  it('新建子分组时 key 紧跟父组，默认排在已有子分组后面', () => {
    const { groups, id } = upsertNavGroup(DOCS_GROUPS, {
      name: '模板',
      items: ['templates'],
      parentId: 'docs',
    });
    const order = orderAfterUpsert(defaultNavOrder(DOCS_GROUPS), groups, id);
    assert.equal(order.indexOf(`group:${id}`), order.indexOf('group:docs') + 1);
  });
});
