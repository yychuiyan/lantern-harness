import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  insertBusinessStep,
  renumberBusinessSteps,
  normalizeStep,
  normalizeSystem,
  localPublishCheck,
} from './business-map';
import { validateBusinessMapSystem } from '../../lh-plugins/lh-business-map.mjs';

const steps = () => [
  normalizeStep({ id: 'a', n: 1, title: '受理', next: '2' }),
  normalizeStep({ id: 'b', n: 2, title: '办理', next: '3' }),
  normalizeStep({ id: 'c', n: 3, title: '办结', next: '结束' }),
];

describe('业务流程步骤编辑', () => {
  it('在指定位置插入并串接顺序边，旧步骤引用随编号更新', () => {
    const original = steps();
    const result = insertBusinessStep(original, normalizeStep({ id: 'new', n: 2, next: '2' }));
    assert.deepEqual(
      result.map((step) => [step.id, step.n, step.next]),
      [
        ['a', 1, '2'],
        ['new', 2, '3'],
        ['b', 3, '4'],
        ['c', 4, '结束'],
      ],
    );
    assert.equal(original.length, 3);
    assert.equal(original[1].n, 2);
  });
  it('追加步骤时连接原结束节点', () => {
    const original = steps();
    const result = insertBusinessStep(original, normalizeStep({ id: 'new', n: 4, next: '结束' }));
    assert.equal(result[2].next, '4');
    assert.equal(result[3].next, '结束');
  });
  it('插入时保留自定义跳转目标', () => {
    const original = steps();
    original[0].next = '3';
    const result = insertBusinessStep(original, normalizeStep({ id: 'new', n: 2, next: '2' }));
    assert.equal(result[0].next, '4');
  });
  it('调整顺序保持原目标，删除目标后清空下一步', () => {
    const original = steps();
    const moved = renumberBusinessSteps(original, [original[1], original[0], original[2]]);
    assert.equal(moved[1].next, '1');
    const removed = renumberBusinessSteps(original, [original[0], original[2]]);
    assert.equal(removed[0].next, '');
    assert.equal(removed[1].n, 2);
  });
});

describe('业务地图发布校验前后端一致', () => {
  it('阻止空流程和不存在的承载功能，允许人工步骤', () => {
    const system = normalizeSystem({
      id: 's',
      name: '测试系统',
      functions: [{ id: 'f', name: '功能', purpose: '测试' }],
      flows: [
        { id: 'empty', name: '空流程', steps: [] },
        {
          id: 'invalid',
          name: '失效引用',
          steps: [{ id: 'step', title: '办理', functionId: 'deleted' }],
        },
      ],
    });
    for (const check of [localPublishCheck(system), validateBusinessMapSystem(system)]) {
      assert.equal(check.ok, false);
      assert.ok(check.items.some((item) => item.code === 'empty_flows'));
      assert.ok(check.items.some((item) => item.code === 'missing_function'));
    }
    system.flows.shift();
    system.flows[0].steps[0].manual = true;
    assert.equal(localPublishCheck(system).ok, true);
    assert.equal(validateBusinessMapSystem(system).ok, true);
  });
});
