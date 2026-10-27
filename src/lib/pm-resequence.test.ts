/**
 * 需求 / 缺陷编号（REQ-### / BUG-###）的压实规则：
 * 删掉中间一条后，被删记录后面的编号整体顺延，不留空洞；顺序以原编号为准（即创建先后），
 * 不依赖数据文件里数组的排列方式（历史文件可能是乱序的）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDelete, normalizeStore } from '../../lh-plugins/lh-pm.mjs';

/** lh-pm.mjs 是纯 JS：这里只取测试用得到的字段 */
interface Row {
  id: string;
  autoId: string;
  requirementId?: string;
}
interface Store {
  seq: Record<string, number>;
  requirements: Row[];
  bugs: Row[];
}

function build(raw: unknown): Store {
  return normalizeStore(raw) as unknown as Store;
}

describe('编号压实', () => {
  it('读入时按原编号顺序补掉空洞，并理顺数组', () => {
    const store = build({
      bugs: [
        { id: 'bg_a', title: 'A', autoId: 'BUG-003' },
        { id: 'bg_b', title: 'B', autoId: 'BUG-001' },
        { id: 'bg_c', title: 'C', autoId: 'BUG-004' },
      ],
    });

    // BUG-002 被删过：剩下的整体顺延，顺序按原编号而不是数组下标
    assert.deepEqual(
      store.bugs.map((b) => b.autoId),
      ['BUG-001', 'BUG-002', 'BUG-003'],
    );
    assert.deepEqual(
      store.bugs.map((b) => b.id),
      ['bg_b', 'bg_a', 'bg_c'],
    );
    assert.equal(store.seq.bugs, 3);
  });

  it('没有编号的历史记录排在最后，拿到最大编号', () => {
    const store = build({
      bugs: [
        { id: 'bg_x', title: 'X' },
        { id: 'bg_y', title: 'Y', autoId: 'BUG-001' },
      ],
    });

    assert.deepEqual(
      store.bugs.map((b) => b.autoId),
      ['BUG-001', 'BUG-002'],
    );
    assert.deepEqual(
      store.bugs.map((b) => b.id),
      ['bg_y', 'bg_x'],
    );
  });

  it('删除中间一条后，后面的编号顺延', () => {
    const store = build({
      bugs: [
        { id: 'bg_1', title: '一' },
        { id: 'bg_2', title: '二' },
        { id: 'bg_3', title: '三' },
      ],
    });
    assert.deepEqual(
      store.bugs.map((b) => b.autoId),
      ['BUG-001', 'BUG-002', 'BUG-003'],
    );

    const dirty = new Set<string>();
    applyDelete(store, 'bugs', ['bg_2'], dirty);

    assert.deepEqual(
      store.bugs.map((b) => b.id),
      ['bg_1', 'bg_3'],
    );
    assert.deepEqual(
      store.bugs.map((b) => b.autoId),
      ['BUG-001', 'BUG-002'],
    );
    assert.equal(store.seq.bugs, 2);
    assert.ok(dirty.has('bugs'));
  });

  it('删需求同样顺延，关联仍走内部 id', () => {
    const store = build({
      requirements: [
        { id: 'rq_1', title: '需求一' },
        { id: 'rq_2', title: '需求二' },
        { id: 'rq_3', title: '需求三' },
      ],
      bugs: [{ id: 'bg_1', title: '缺陷一', requirementId: 'rq_2' }],
    });
    assert.equal(store.bugs[0].requirementId, 'rq_2');

    const dirty = new Set<string>();
    applyDelete(store, 'requirements', ['rq_1'], dirty);

    assert.deepEqual(
      store.requirements.map((r) => r.autoId),
      ['REQ-001', 'REQ-002'],
    );
    assert.deepEqual(
      store.requirements.map((r) => r.id),
      ['rq_2', 'rq_3'],
    );
    // 编号只是展示序号：缺陷仍指向原来的内部 id
    assert.equal(store.bugs[0].requirementId, 'rq_2');
    assert.ok(dirty.has('requirements'));
  });
});
