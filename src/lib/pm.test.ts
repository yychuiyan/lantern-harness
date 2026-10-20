import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bugTitleFromDescription,
  filterBugs,
  filterIterations,
  filterProjects,
  filterRequirements,
  findByName,
  findRequirementByTitle,
  isBugFinished,
  iterationOverdueDays,
  iterationProgressPercent,
  joinAttachments,
  normalizeBugStatus,
  normalizePmStore,
  parseAttachments,
  projectStats,
  sortBugsNewestFirst,
  sortIterationsNewestFirst,
  type BugItem,
  type IterationItem,
  type ProjectItem,
  type RequirementItem,
} from './pm';

function project(over: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: 'pj_1',
    name: '任务管理系统',
    description: '',
    status: 'planning',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function iteration(over: Partial<IterationItem> = {}): IterationItem {
  return {
    id: 'it_1',
    projectId: 'pj_1',
    name: '迭代一',
    startDate: '2026-07-11',
    endDate: '2026-07-22',
    status: 'in_progress',
    remark: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function requirement(over: Partial<RequirementItem> = {}): RequirementItem {
  return {
    id: 'rq_1',
    autoId: 'REQ-001',
    projectId: 'pj_1',
    iterationId: 'it_1',
    title: '登录',
    priority: 'medium',
    status: 'pending',
    description: '',
    acceptanceCriteria: [],
    githubIssue: '',
    attachment: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function bug(over: Partial<BugItem> = {}): BugItem {
  return {
    id: 'bg_1',
    autoId: 'BUG-001',
    projectId: 'pj_1',
    iterationId: 'it_1',
    requirementId: 'rq_1',
    title: '按钮点不动',
    severity: 'minor',
    status: 'pending',
    reproduceSteps: '',
    expectedResult: '',
    actualResult: '',
    environment: '',
    githubIssue: '',
    attachment: '',
    remark: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('iterationProgressPercent', () => {
  const item = iteration();

  it('开始当天不是 0，结束当天是 100', () => {
    assert.equal(iterationProgressPercent(item, '2026-07-11'), Math.round((1 / 12) * 100));
    assert.equal(iterationProgressPercent(item, '2026-07-22'), 100);
  });

  it('未开始是 0，结束后封顶 100', () => {
    assert.equal(iterationProgressPercent(item, '2026-07-01'), 0);
    assert.equal(iterationProgressPercent(item, '2026-08-30'), 100);
  });

  it('缺日期或日期非法时返回 0', () => {
    assert.equal(iterationProgressPercent(iteration({ startDate: '' }), '2026-07-15'), 0);
    assert.equal(iterationProgressPercent(iteration({ endDate: '' }), '2026-07-15'), 0);
  });
});

describe('iterationOverdueDays', () => {
  it('过了截止日期才算逾期', () => {
    assert.equal(iterationOverdueDays(iteration(), '2026-07-21'), null);
    assert.equal(iterationOverdueDays(iteration(), '2026-07-22'), null);
    assert.equal(iterationOverdueDays(iteration(), '2026-07-27'), 5);
  });

  it('已完成的迭代不算逾期', () => {
    assert.equal(iterationOverdueDays(iteration({ status: 'done' }), '2026-08-01'), null);
  });
});

describe('projectStats', () => {
  it('按项目汇总迭代 / 需求 / 缺陷与完成度', () => {
    const stats = projectStats({
      projects: [project(), project({ id: 'pj_2', name: '空项目' })],
      iterations: [iteration(), iteration({ id: 'it_2', projectId: 'pj_2' })],
      requirements: [
        requirement(),
        requirement({ id: 'rq_2', status: 'done' }),
        requirement({ id: 'rq_3', status: 'cancelled' }),
      ],
      bugs: [bug(), bug({ id: 'bg_2', status: 'passed' })],
    });

    assert.deepEqual(stats.pj_1, {
      iterations: 1,
      requirements: 3,
      requirementsDone: 1,
      bugs: 2,
      bugsClosed: 1,
      requirementPercent: 33,
      bugClosedPercent: 50,
    });
    assert.deepEqual(stats.pj_2, {
      iterations: 1,
      requirements: 0,
      requirementsDone: 0,
      bugs: 0,
      bugsClosed: 0,
      requirementPercent: 0,
      bugClosedPercent: 100,
    });
  });
});

describe('筛选', () => {
  it('项目按状态与关键字筛选', () => {
    const items = [project(), project({ id: 'pj_2', name: '官网', status: 'archived' })];
    assert.equal(filterProjects(items, { status: 'archived' }).length, 1);
    assert.equal(filterProjects(items, { keyword: '官网' })[0]?.id, 'pj_2');
    assert.equal(filterProjects(items, {}).length, 2);
  });

  it('迭代按项目与状态筛选', () => {
    const items = [iteration(), iteration({ id: 'it_2', projectId: 'pj_2', status: 'done' })];
    assert.equal(filterIterations(items, { projectId: 'pj_2' }).length, 1);
    assert.equal(filterIterations(items, { status: 'done' })[0]?.id, 'it_2');
  });

  it('需求按状态 / 优先级 / 关键字筛选', () => {
    const items = [
      requirement(),
      requirement({
        id: 'rq_2',
        autoId: 'REQ-002',
        status: 'done',
        priority: 'urgent',
        title: '支付',
      }),
    ];
    assert.equal(filterRequirements(items, { status: 'done' }).length, 1);
    assert.equal(filterRequirements(items, { priority: 'urgent' })[0]?.id, 'rq_2');
    assert.equal(filterRequirements(items, { keyword: 'REQ-001' }).length, 1);
  });

  it('缺陷按严重程度 / 迭代筛选', () => {
    const items = [
      bug(),
      bug({ id: 'bg_2', severity: 'critical', iterationId: '', status: 'passed' }),
    ];
    assert.equal(filterBugs(items, { severity: 'critical' }).length, 1);
    assert.equal(filterBugs(items, { iterationId: 'it_1' }).length, 1);
    assert.equal(filterBugs(items, { status: 'passed' })[0]?.id, 'bg_2');
  });

  it('缺陷默认按创建时间倒序，时间相同按编号倒序', () => {
    const items = [
      bug({ id: 'a', autoId: 'BUG-001', createdAt: '2026-10-19T07:52:04.270Z' }),
      bug({ id: 'c', autoId: 'BUG-003', createdAt: '2026-10-19T13:46:09.343Z' }),
      bug({ id: 'b', autoId: 'BUG-002', createdAt: '2026-10-19T13:44:05.456Z' }),
      bug({ id: 'd', autoId: 'BUG-010', createdAt: '2026-10-19T13:44:05.456Z' }),
    ];
    assert.deepEqual(
      sortBugsNewestFirst(items).map((x) => x.autoId),
      ['BUG-003', 'BUG-010', 'BUG-002', 'BUG-001'],
    );
    // 不改原数组
    assert.equal(items[0]?.autoId, 'BUG-001');
  });

  it('迭代下拉按开始日期倒序，同日按创建时间倒序', () => {
    const items = [
      iteration({ id: 'a', name: 'v0.1.7', startDate: '2026-10-19' }),
      iteration({
        id: 'b',
        name: 'v0.1.9',
        startDate: '2026-10-20',
        createdAt: '2026-10-20T01:12:13.530Z',
      }),
      iteration({
        id: 'c',
        name: 'v0.1.10',
        startDate: '2026-10-20',
        createdAt: '2026-10-20T02:12:13.530Z',
      }),
    ];
    assert.deepEqual(
      sortIterationsNewestFirst(items).map((x) => x.name),
      ['v0.1.10', 'v0.1.9', 'v0.1.7'],
    );
    // 不改原数组
    assert.equal(items[0]?.name, 'v0.1.7');
  });

  it('缺陷没写创建时间时排到最后', () => {
    const items = [
      bug({ id: 'x', autoId: 'BUG-001', createdAt: '' }),
      bug({ id: 'y', autoId: 'BUG-002', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    assert.deepEqual(
      sortBugsNewestFirst(items).map((x) => x.autoId),
      ['BUG-002', 'BUG-001'],
    );
  });
});

describe('名称查找', () => {
  it('先精确再忽略大小写', () => {
    const items = [
      { id: 'pj_1', name: 'Task' },
      { id: 'pj_2', name: 'Flow' },
    ];
    assert.equal(findByName(items, 'Flow'), 'pj_2');
    assert.equal(findByName(items, 'flow'), 'pj_2');
    assert.equal(findByName(items, '不存在'), '');
  });

  it('需求可按标题或编号查找', () => {
    const items = [requirement()];
    assert.equal(findRequirementByTitle(items, '登录'), 'rq_1');
    assert.equal(findRequirementByTitle(items, 'req-001'), 'rq_1');
    assert.equal(findRequirementByTitle(items, '其他'), '');
  });
});

describe('缺陷描述与附件', () => {
  it('标题取描述第一行，最多 60 字', () => {
    assert.equal(bugTitleFromDescription('  登录按钮点击无效\n更多细节'), '登录按钮点击无效');
    assert.equal(bugTitleFromDescription('\n\n  '), '');
    assert.equal(bugTitleFromDescription('一'.repeat(80)).length, 60);
  });

  it('附件地址按换行解析，展示名去掉落盘前缀', () => {
    const url =
      '/__tb_pm/file?p=%E7%BC%BA%E9%99%B7%E7%AE%A1%E7%90%86%2F%E9%99%84%E4%BB%B6%2F1700000000000-abc123-%E6%88%AA%E5%9B%BE.png';
    const list = parseAttachments(`${url}\n\nhttps://example.com/a.log`);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.name, '截图.png');
    assert.equal(list[1]?.name, 'a.log');
    assert.equal(joinAttachments(list), `${url}\nhttps://example.com/a.log`);
    assert.deepEqual(parseAttachments(''), []);
  });
});

describe('normalizePmStore', () => {
  it('丢掉缺少必填字段的记录，缺省值补全', () => {
    const store = normalizePmStore({
      projects: [{ id: 'pj_1', name: '项目 A' }, { name: '' }],
      iterations: [{ id: 'it_1', projectId: 'pj_1', name: '迭代' }, { name: '' }],
      requirements: [{ id: 'rq_1', projectId: 'pj_1', title: '需求' }],
      bugs: [{ id: 'bg_1', projectId: 'pj_1', title: '缺陷' }],
    });
    assert.equal(store.projects.length, 1);
    assert.equal(store.projects[0]?.status, 'planning');
    assert.equal(store.iterations.length, 1);
    assert.equal(store.iterations[0]?.startDate, '');
    assert.equal(store.requirements[0]?.priority, 'medium');
    assert.equal(store.requirements[0]?.status, 'pending');
    assert.equal(store.bugs[0]?.severity, 'minor');
    assert.equal(store.bugs[0]?.status, 'pending');
  });

  it('输入不是对象时返回空 store', () => {
    assert.deepEqual(normalizePmStore(null), {
      projects: [],
      iterations: [],
      requirements: [],
      bugs: [],
    });
  });
});

describe('缺陷状态迁移', () => {
  it('新状态原样保留', () => {
    for (const s of ['pending', 'todo', 'fixed', 'verifying', 'passed', 'cancelled']) {
      assert.equal(normalizeBugStatus(s), s);
    }
  });

  it('旧值转成新状态', () => {
    assert.equal(normalizeBugStatus('in_progress'), 'fixed');
    assert.equal(normalizeBugStatus('closed'), 'passed');
  });

  it('未知值 / 非字符串返回空串', () => {
    assert.equal(normalizeBugStatus('done'), '');
    assert.equal(normalizeBugStatus(null), '');
    assert.equal(normalizeBugStatus(1), '');
  });

  it('只有验证通过与已取消算收尾', () => {
    assert.equal(isBugFinished('passed'), true);
    assert.equal(isBugFinished('cancelled'), true);
    assert.equal(isBugFinished('verifying'), false);
    assert.equal(isBugFinished('fixed'), false);
  });

  it('读取旧 JSON 时自动迁移，不丢记录', () => {
    const store = normalizePmStore({
      projects: [{ id: 'pj_1', name: 'P' }],
      bugs: [
        { id: 'bg_1', title: 'A', status: 'closed' },
        { id: 'bg_2', title: 'B', status: 'in_progress' },
        { id: 'bg_3', title: 'C', status: 'verifying' },
      ],
    });
    assert.deepEqual(
      store.bugs.map((b) => b.status),
      ['passed', 'fixed', 'verifying'],
    );
  });
});
