import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addMissingCaseTypeSiblings,
  addMissingTestReportTypeSiblings,
  NAV_ENTRIES,
  TEST_REPORT_TYPE_NAV_ENTRY_IDS,
  buildNavRenderList,
  DEFAULT_NAV_GROUPS,
  defaultNavOrder,
  moveNavOrder,
  normalizeNavGroups,
  normalizeNavOrder,
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
  navEntryForPath,
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

  it('旧的用例管理分组自动补齐四个类型菜单', () => {
    const next = addMissingCaseTypeSiblings([
      { id: 'qa', name: '测试管理', items: ['cases', 'caseExecution'] },
    ]);
    assert.deepEqual(next[0]?.items, [
      'cases',
      'caseApi',
      'casePerformance',
      'caseAutomation',
      'caseOther',
      'caseExecution',
    ]);
  });

  it('旧的报告管理分组自动补齐两个类型菜单', () => {
    const next = addMissingTestReportTypeSiblings([
      { id: 'qa', name: '测试管理', items: ['testReports', 'testStats'] },
    ]);
    assert.deepEqual(next[0]?.items, [
      'testReports',
      'testReportApi',
      'testReportPerformance',
      'testStats',
    ]);
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
    const order = ['item:cases', 'group:docs', 'item:knowledgeLib'];
    const next = removeNavGroup(groups, 'docs');
    const list = buildNavRenderList(next, orderAfterRemove(order, groups[0]!, next));
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'cases',
        'caseApi',
        'casePerformance',
        'caseAutomation',
        'caseOther',
        'knowledgeLib',
        'requirements',
        'templates',
        'dashboard',
        'tasks',
        'todos',
        'lifeKrTodos',
        'lifeKrTasks',
        'lifeObjectives',
        'lifeReviews',
        'lifeYearPlans',
        'lifeStages',
        'projects',
        'iterations',
        'pmRequirements',
        'bugs',
        'reports',
        'testStats',
        'caseExec',
        'caseExecution',
        'uiAutoProjects',
        'uiAuto',
        'reqAnalysis',
        'reqBreakdowns',
        'businessMap',
        'defectSubmit',
        'testReports',
        'testReportApi',
        'testReportPerformance',
      ],
    );
  });
});

describe('buildNavRenderList', () => {
  it('默认顺序：仪表盘 / 任务 / 待办 / 项目管理 / 汇报 / 测试统计 + 其它库 + 文档库分组', () => {
    const list = buildNavRenderList(DOCS_GROUPS);
    assert.equal(list[0].type, 'item');
    if (list[0].type === 'item') assert.equal(list[0].id, 'dashboard');
    if (list[1].type === 'item') assert.equal(list[1].id, 'tasks');
    const docs = list.find((entry) => entry.type === 'group' && entry.group.id === 'docs');
    assert.ok(docs && docs.type === 'group');
    if (docs.type === 'group') {
      assert.deepEqual(docs.group.items, ['requirements', 'templates']);
    }
  });

  it('按 navOrder 重排顶层', () => {
    const list = buildNavRenderList(DOCS_GROUPS, ['group:docs', 'item:cases', 'item:knowledgeLib']);
    assert.deepEqual(
      list.map((n) => (n.type === 'item' ? n.id : n.group.id)),
      [
        'docs',
        'cases',
        'caseApi',
        'casePerformance',
        'caseAutomation',
        'caseOther',
        'knowledgeLib',
        'dashboard',
        'tasks',
        'todos',
        'lifeKrTodos',
        'lifeKrTasks',
        'lifeObjectives',
        'lifeReviews',
        'lifeYearPlans',
        'lifeStages',
        'projects',
        'iterations',
        'pmRequirements',
        'bugs',
        'reports',
        'testStats',
        'caseExec',
        'caseExecution',
        'uiAutoProjects',
        'uiAuto',
        'reqAnalysis',
        'reqBreakdowns',
        'businessMap',
        'defectSubmit',
        'testReports',
        'testReportApi',
        'testReportPerformance',
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
      ['item:cases', 'item:knowledgeLib', 'item:requirements', 'item:templates'],
      groups,
      id,
    );
    assert.deepEqual(order, [
      'item:cases',
      'item:caseApi',
      'item:casePerformance',
      'item:caseAutomation',
      'item:caseOther',
      'item:knowledgeLib',
      `group:${id}`,
      'item:dashboard',
      'item:tasks',
      'item:todos',
      'item:lifeKrTodos',
      'item:lifeKrTasks',
      'item:lifeObjectives',
      'item:lifeReviews',
      'item:lifeYearPlans',
      'item:lifeStages',
      'item:projects',
      'item:iterations',
      'item:pmRequirements',
      'item:bugs',
      'item:reports',
      'item:testStats',
      'item:caseExec',
      'item:caseExecution',
      'item:uiAutoProjects',
      'item:uiAuto',
      'item:reqAnalysis',
      'item:reqBreakdowns',
      'item:businessMap',
      'item:defectSubmit',
      'item:testReports',
      'item:testReportApi',
      'item:testReportPerformance',
    ]);
  });

  it('上移下移交换相邻项', () => {
    const order = defaultNavOrder(DOCS_GROUPS);
    const at = order.indexOf('item:cases');
    const moved = moveNavOrder(order, 'item:cases', 1);
    assert.equal(moved[at], 'item:caseApi');
    assert.equal(moved[at + 1], 'item:cases');
  });

  it('新增菜单项按默认顺序插到兄弟项旁边，而不是丢到末尾', () => {
    // 模拟老空间保存的旧顺序：还没有 item:uiAutoProjects
    const saved = defaultNavOrder([]).filter((key) => key !== 'item:uiAutoProjects');
    const next = normalizeNavOrder(saved, []);
    const at = next.indexOf('item:uiAutoProjects');
    assert.ok(at > 0);
    assert.equal(next[at - 1], 'item:caseExecution');
    assert.equal(next[at + 1], 'item:uiAuto');
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
        'lifeKrTodos',
        'lifeKrTasks',
        'lifeObjectives',
        'lifeReviews',
        'lifeYearPlans',
        'lifeStages',
        'projects',
        'iterations',
        'pmRequirements',
        'bugs',
        'reports',
        'testStats',
        'caseExec',
        'caseExecution',
        'uiAutoProjects',
        'uiAuto',
        'reqAnalysis',
        'reqBreakdowns',
        'businessMap',
        'defectSubmit',
        'cases',
        'caseApi',
        'casePerformance',
        'caseAutomation',
        'caseOther',
        'knowledgeLib',
        'docs',
        'templates',
        'testReports',
        'testReportApi',
        'testReportPerformance',
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
        'lifeKrTodos',
        'lifeKrTasks',
        'lifeObjectives',
        'lifeReviews',
        'lifeYearPlans',
        'lifeStages',
        'projects',
        'iterations',
        'pmRequirements',
        'bugs',
        'reports',
        'testStats',
        'caseExec',
        'caseExecution',
        'uiAutoProjects',
        'uiAuto',
        'reqAnalysis',
        'reqBreakdowns',
        'businessMap',
        'defectSubmit',
        'cases',
        'caseApi',
        'casePerformance',
        'caseAutomation',
        'caseOther',
        'knowledgeLib',
        'docs',
        'testReports',
        'testReportApi',
        'testReportPerformance',
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
      'item:lifeKrTodos',
      'item:lifeKrTasks',
      'item:lifeObjectives',
      'item:lifeReviews',
      'item:lifeYearPlans',
      'item:lifeStages',
      'item:projects',
      'item:iterations',
      'item:pmRequirements',
      'item:bugs',
      'item:reports',
      'item:testStats',
      'item:caseExec',
      'item:caseExecution',
      'item:uiAutoProjects',
      'item:uiAuto',
      'item:reqAnalysis',
      'item:reqBreakdowns',
      'item:businessMap',
      'item:defectSubmit',
      'item:caseApi',
      'item:casePerformance',
      'item:caseAutomation',
      'item:caseOther',
      'item:knowledgeLib',
      'group:docs',
      'item:cases',
      'item:testReports',
      'item:testReportApi',
      'item:testReportPerformance',
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
        'lifeKrTodos',
        'lifeKrTasks',
        'lifeObjectives',
        'lifeReviews',
        'lifeYearPlans',
        'lifeStages',
        'projects',
        'iterations',
        'pmRequirements',
        'bugs',
        'reports',
        'testStats',
        'caseExec',
        'caseExecution',
        'uiAutoProjects',
        'uiAuto',
        'reqAnalysis',
        'reqBreakdowns',
        'businessMap',
        'defectSubmit',
        'g',
        'caseApi',
        'casePerformance',
        'caseAutomation',
        'caseOther',
        'knowledgeLib',
        'testReports',
        'testReportApi',
        'testReportPerformance',
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

describe('路径命中的菜单项', () => {
  it('识别插件页（带不带结尾斜杠都行）', () => {
    assert.equal(navEntryForPath('/pm/bugs/')?.id, 'bugs');
    assert.equal(navEntryForPath('/pm/bugs')?.id, 'bugs');
    assert.equal(navEntryForPath('/pm/requirements/')?.id, 'pmRequirements');
    assert.equal(navEntryForPath('/case-exec/')?.id, 'caseExec');
    assert.equal(navEntryForPath('/cases/functional/')?.id, 'cases');
    assert.equal(navEntryForPath('/cases/api/')?.id, 'caseApi');
    assert.equal(navEntryForPath('/cases/performance/')?.id, 'casePerformance');
    assert.equal(navEntryForPath('/cases/automation/')?.id, 'caseAutomation');
    assert.equal(navEntryForPath('/cases/other/')?.id, 'caseOther');
    assert.equal(navEntryForPath('/test-reports/functional/')?.id, 'testReports');
    assert.equal(navEntryForPath('/test-reports/api/')?.id, 'testReportApi');
    assert.equal(navEntryForPath('/test-reports/performance/')?.id, 'testReportPerformance');
    assert.equal(navEntryForPath('/case-execution/')?.id, 'caseExecution');
    assert.equal(navEntryForPath('/case-execution/some-run/')?.id, 'caseExecution');
    assert.equal(navEntryForPath('/requirement-breakdowns/')?.id, 'reqBreakdowns');
  });

  it('自动化项目与自动化执行按子路径分开高亮', () => {
    assert.equal(navEntryForPath('/test-automation/')?.id, 'uiAuto');
    assert.equal(navEntryForPath('/test-automation/projects/')?.id, 'uiAutoProjects');
    assert.equal(navEntryForPath('/test-automation/projects')?.id, 'uiAutoProjects');
  });

  it('工作台与未知路径不返回菜单项', () => {
    assert.equal(navEntryForPath('/'), null);
    assert.equal(navEntryForPath('/todo-not-a-page/'), null);
  });

  it('带部署子路径时先剥掉 base', () => {
    assert.equal(navEntryForPath('/lantern/dashboard/', '/lantern/')?.id, 'dashboard');
    assert.equal(navEntryForPath('/lantern/', '/lantern/'), null);
  });

  it('长 match 优先，前缀不会互相盖住', () => {
    assert.equal(navEntryForPath('/requirements/')?.id, 'requirements');
    assert.equal(navEntryForPath('/pm/requirements/')?.id, 'pmRequirements');
  });
});

describe('报告管理三菜单', () => {
  it('三个菜单共同绑定报告管理插件并使用固定页面', () => {
    const entries = NAV_ENTRIES.filter((entry) =>
      (TEST_REPORT_TYPE_NAV_ENTRY_IDS as readonly string[]).includes(entry.id),
    );
    assert.deepEqual(
      entries.map((entry) => entry.href),
      ['test-reports/functional/', 'test-reports/api/', 'test-reports/performance/'],
    );
    assert.ok(entries.every((entry) => entry.plugin === 'testReports'));
  });
});
