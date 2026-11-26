import assert from 'node:assert/strict';
import test from 'node:test';

import type { BusinessFlow, BusinessFlowStep } from './business-map';
import {
  buildBusinessFlowDiagram,
  connectorPath,
  FLOW_DIAGRAM_COLUMN_GAP,
  FLOW_DIAGRAM_LANE_HEIGHT,
  FLOW_DIAGRAM_MAX_ROW_STEPS,
  FLOW_DIAGRAM_NODE_WIDTH,
  rowConnectorPath,
} from './business-flow-diagram';

function step(n: number, values: Partial<BusinessFlowStep> = {}): BusinessFlowStep {
  return {
    id: `step-${n}`,
    n,
    title: `步骤 ${n}`,
    role: '',
    system: '工单系统',
    functionId: '',
    input: '',
    output: '',
    next: String(n + 1),
    branch: '',
    branchBroken: false,
    manual: false,
    dependencies: [],
    evidence: [],
    ...values,
  };
}

function flow(steps: BusinessFlowStep[]): BusinessFlow {
  return {
    id: 'flow-1',
    code: 'P1',
    name: '测试流程',
    result: '完成',
    status: '健康',
    steps,
    evidence: [],
    createdAt: '',
    updatedAt: '',
  };
}

test('按参与系统分泳道，并按 n 排列节点列', () => {
  const layout = buildBusinessFlowDiagram(
    flow([
      step(2, { system: '客户系统' }),
      step(1, { system: '工单系统' }),
      step(3, { system: '工单系统' }),
    ]),
    'system',
  );

  assert.deepEqual(
    layout.lanes.map((lane) => lane.label),
    ['工单系统', '客户系统'],
  );
  assert.deepEqual(
    layout.nodes.map((node) => node.step.n),
    [1, 2, 3],
  );
  assert.equal(layout.nodes[1].laneIndex, 1);
  assert.equal(
    layout.nodes[2].x - layout.nodes[1].x,
    FLOW_DIAGRAM_NODE_WIDTH + FLOW_DIAGRAM_COLUMN_GAP,
  );
  assert.equal(layout.height, 36 + 2 * FLOW_DIAGRAM_LANE_HEIGHT);
});

test('切换角色分组会保留主链路顺序并识别未标注角色', () => {
  const layout = buildBusinessFlowDiagram(
    flow([step(1, { role: '受理人员' }), step(2, { role: '' }), step(3, { role: '审核人员' })]),
    'role',
  );

  assert.deepEqual(
    layout.lanes.map((lane) => lane.label),
    ['受理人员', '未标注角色', '审核人员'],
  );
  assert.deepEqual(
    layout.nodes.map((node) => node.step.n),
    [1, 2, 3],
  );
});

test('单泳道长流程自动均衡折行，步骤顺序保持连续', () => {
  const layout = buildBusinessFlowDiagram(
    flow(Array.from({ length: 9 }, (_, index) => step(index + 1))),
    'system',
  );

  assert.equal(layout.lanes.length, 1);
  assert.equal(layout.lanes[0].rowCount, 3);
  assert.equal(layout.lanes[0].height, 3 * FLOW_DIAGRAM_LANE_HEIGHT);
  assert.equal(layout.height, 36 + 3 * FLOW_DIAGRAM_LANE_HEIGHT);
  assert.deepEqual(
    layout.nodes.map((node) => node.flowRow),
    [0, 0, 0, 1, 1, 1, 2, 2, 2],
  );
  assert.ok(layout.nodes.every((node) => node.x + node.width <= layout.width));
  assert.match(layout.connectors[2].path, / V /);
});

test('多泳道仍按系统分行展示，不在同一泳道内折行', () => {
  const layout = buildBusinessFlowDiagram(
    flow([
      step(1, { system: '工单系统' }),
      step(2, { system: '知识库系统' }),
      step(3, { system: '工单系统' }),
      step(4, { system: '知识库系统' }),
      step(5, { system: '工单系统' }),
    ]),
    'system',
  );

  assert.equal(layout.lanes.length, 2);
  assert.deepEqual(
    layout.lanes.map((lane) => lane.rowCount),
    [1, 1],
  );
  assert.ok(layout.nodes.every((node) => node.flowRow === 0));
  assert.equal(layout.nodes.length, 5);
  assert.ok(layout.nodes.length > FLOW_DIAGRAM_MAX_ROW_STEPS);
});

test('同泳道连接为水平线，跨泳道连接为曲线', () => {
  const sameLane = connectorPath(
    { x: 0, y: 10, width: 100, height: 40 },
    { x: 200, y: 10, width: 100, height: 40 },
  );
  const crossLane = connectorPath(
    { x: 0, y: 10, width: 100, height: 40 },
    { x: 200, y: 120, width: 100, height: 40 },
  );
  const reverse = connectorPath(
    { x: 200, y: 10, width: 100, height: 40 },
    { x: 0, y: 10, width: 100, height: 40 },
  );

  assert.match(sameLane, /^M 100 30 H 200$/);
  assert.match(crossLane, / C /);
  assert.match(reverse, /^M 200 30 H 100$/);
});

test('折行连接从上一行底部垂直进入下一行顶部', () => {
  const path = rowConnectorPath(
    { x: 300, y: 20, width: 100, height: 40 },
    { x: 300, y: 220, width: 100, height: 40 },
  );

  assert.equal(path, 'M 350 60 V 220');
});

test('连线遵循跳转、回退和条件分支，不补相邻顺序边', () => {
  const layout = buildBusinessFlowDiagram(
    flow([
      step(1, { next: '3', branch: '退回→2；办结→结束' }),
      step(2, { next: '1' }),
      step(3, { next: '' }),
    ]),
    'role',
  );
  assert.deepEqual(
    layout.connectors.map(({ fromStepId, toStepId }) => [fromStepId, toStepId]),
    [
      ['step-1', 'step-3'],
      ['step-1', 'step-2'],
      ['step-2', 'step-1'],
    ],
  );
  assert.match(layout.connectors[2].path, / V /);
  assert.equal(
    buildBusinessFlowDiagram(flow([step(1, { next: '' }), step(2, { next: '' })]), 'role')
      .connectors.length,
    0,
  );
});
