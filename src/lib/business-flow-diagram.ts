import { nextTargets, branchTargets } from '../../lh-plugins/business-map/flow-links.mjs';
import type { BusinessFlow, BusinessFlowStep } from './business-map';

export type BusinessFlowLaneMode = 'role' | 'system';

export const FLOW_DIAGRAM_LANE_HEIGHT = 248;
export const FLOW_DIAGRAM_NODE_WIDTH = 170;
export const FLOW_DIAGRAM_NODE_HEIGHT = 190;
export const FLOW_DIAGRAM_COLUMN_GAP = 60;
export const FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH = 42;
export const FLOW_DIAGRAM_TERMINAL_GAP = 0;
/** 为「开始」胶囊和可见箭头留出水平空间。 */
export const FLOW_DIAGRAM_TRACK_START = 88;
export const FLOW_DIAGRAM_TRACK_END = 88;
export const FLOW_DIAGRAM_TOP = 18;
export const FLOW_DIAGRAM_MAX_ROW_STEPS = 4;
export const FLOW_DIAGRAM_MIN_ZOOM = 0.6;
export const FLOW_DIAGRAM_MAX_ZOOM = 1.8;
export const FLOW_DIAGRAM_ZOOM_STEP = 0.1;

export function normalizeFlowDiagramZoom(value: number) {
  return Math.min(
    FLOW_DIAGRAM_MAX_ZOOM,
    Math.max(FLOW_DIAGRAM_MIN_ZOOM, Math.round(value * 10) / 10),
  );
}

export interface FlowDiagramLane {
  key: string;
  label: string;
  index: number;
  y: number;
  height: number;
  rowCount: number;
  stepCount: number;
}

export interface FlowDiagramNode {
  step: BusinessFlowStep;
  laneIndex: number;
  flowRow: number;
  flowDirection: 1 | -1;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowDiagramConnector {
  fromStepId: string;
  toStepId: string;
  path: string;
}

export interface BusinessFlowDiagramLayout {
  width: number;
  height: number;
  lanes: FlowDiagramLane[];
  nodes: FlowDiagramNode[];
  connectors: FlowDiagramConnector[];
}

function laneValue(step: BusinessFlowStep, mode: BusinessFlowLaneMode) {
  const value = (mode === 'role' ? step.role : step.system).trim();
  return value || (mode === 'role' ? '未标注角色' : '未标注参与系统');
}

export function connectorPath(
  from: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
  to: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
) {
  const movingRight = to.x > from.x;
  const fromX = movingRight ? from.x + from.width : from.x;
  const fromY = from.y + from.height / 2;
  const toX = movingRight ? to.x : to.x + to.width;
  const toY = to.y + to.height / 2;
  const midX = (fromX + toX) / 2;

  if (Math.abs(fromY - toY) < 1) {
    return `M ${fromX} ${fromY} H ${toX}`;
  }

  return `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
}

export function rowConnectorPath(
  from: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
  to: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
) {
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height;
  const toX = to.x + to.width / 2;
  const toY = to.y;
  const midY = (fromY + toY) / 2;

  if (Math.abs(fromX - toX) < 1) {
    return `M ${fromX} ${fromY} V ${toY}`;
  }

  return `M ${fromX} ${fromY} V ${midY} H ${toX} V ${toY}`;
}

function crossRowDetourPath(
  from: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
  to: Pick<FlowDiagramNode, 'x' | 'y' | 'width' | 'height'>,
) {
  const fromX = from.x + from.width / 2;
  const toX = to.x + to.width / 2;
  const targetIsBelow = to.y > from.y;
  const fromY = targetIsBelow ? from.y + from.height : from.y;
  const toY = targetIsBelow ? to.y : to.y + to.height;
  const midY = (fromY + toY) / 2;

  if (Math.abs(fromX - toX) < 1) {
    return `M ${fromX} ${fromY} V ${toY}`;
  }

  return `M ${fromX} ${fromY} V ${midY} H ${toX} V ${toY}`;
}

function balancedRowSizes(stepCount: number) {
  const rowCount = Math.ceil(stepCount / FLOW_DIAGRAM_MAX_ROW_STEPS);
  const base = Math.floor(stepCount / rowCount);
  const extra = stepCount % rowCount;
  return Array.from({ length: rowCount }, (_, index) => base + (index < extra ? 1 : 0));
}

function targetStepsByTitle(
  value: string,
  steps: BusinessFlowStep[],
  currentStep: BusinessFlowStep,
): number[] {
  const text = String(value || '').trim();
  if (!text) return [];
  const candidates = steps
    .filter((step) => step.id !== currentStep.id)
    .filter((step) => {
      const title = step.title.trim();
      return Boolean(title) && (text === title || text.includes(title) || title.includes(text));
    });
  const exact = candidates.find((step) => step.title.trim() === text);
  if (exact) return [exact.n];
  const closest = candidates.sort((left, right) => right.title.length - left.title.length)[0];
  return closest ? [closest.n] : [];
}

function isTerminalNext(value: string) {
  const text = String(value || '').trim();
  return /^(?:(?:流程|工单|当前流程|本流程)?(?:结束|完成|终止))(?:\s*[，,；;].*)?$|^end(?:\s|$)/i.test(
    text,
  );
}

/**
 * 把业务流程按泳道折叠成固定坐标的图。节点始终按步骤 n 排成列，
 * 角色或系统变化只改变节点纵向位置；单泳道长流程会均衡折成多行。
 */
export function buildBusinessFlowDiagram(
  flow: BusinessFlow,
  mode: BusinessFlowLaneMode,
): BusinessFlowDiagramLayout {
  const orderedSteps = [...flow.steps].sort((left, right) => left.n - right.n);
  const laneOrder: string[] = [];
  const laneCounts = new Map<string, number>();

  for (const step of orderedSteps) {
    const key = laneValue(step, mode);
    if (!laneCounts.has(key)) laneOrder.push(key);
    laneCounts.set(key, (laneCounts.get(key) || 0) + 1);
  }

  const wrapsSingleLane =
    laneOrder.length === 1 && orderedSteps.length > FLOW_DIAGRAM_MAX_ROW_STEPS;
  const rowSizes = wrapsSingleLane ? balancedRowSizes(orderedSteps.length) : [orderedSteps.length];
  let laneY = FLOW_DIAGRAM_TOP;
  const lanes = laneOrder.map((label, index) => {
    const rowCount = wrapsSingleLane ? rowSizes.length : 1;
    const lane = {
      key: `${mode}:${label}`,
      label,
      index,
      y: laneY,
      height: rowCount * FLOW_DIAGRAM_LANE_HEIGHT,
      rowCount,
      stepCount: laneCounts.get(label) || 0,
    };
    laneY += lane.height;
    return lane;
  });
  const laneIndexByLabel = new Map(lanes.map((lane) => [lane.label, lane.index]));

  const maxColumns = Math.max(1, ...rowSizes);
  const nodes: FlowDiagramNode[] = [];
  let stepCursor = 0;

  for (const [flowRow, rowSize] of rowSizes.entries()) {
    for (let rowColumn = 0; rowColumn < rowSize; rowColumn += 1) {
      const step = orderedSteps[stepCursor];
      const laneIndex = laneIndexByLabel.get(laneValue(step, mode)) || 0;
      const visualColumn = flowRow % 2 === 0 ? rowColumn : Math.max(0, maxColumns - 1 - rowColumn);
      nodes.push({
        step,
        laneIndex,
        flowRow,
        flowDirection: flowRow % 2 === 0 ? 1 : -1,
        column: stepCursor,
        x:
          FLOW_DIAGRAM_TRACK_START +
          visualColumn * (FLOW_DIAGRAM_NODE_WIDTH + FLOW_DIAGRAM_COLUMN_GAP),
        y:
          lanes[laneIndex].y +
          flowRow * FLOW_DIAGRAM_LANE_HEIGHT +
          (FLOW_DIAGRAM_LANE_HEIGHT - FLOW_DIAGRAM_NODE_HEIGHT) / 2,
        width: FLOW_DIAGRAM_NODE_WIDTH,
        height: FLOW_DIAGRAM_NODE_HEIGHT,
      });
      stepCursor += 1;
    }
  }

  const nodeByNumber = new Map(nodes.map((node) => [node.step.n, node]));
  const orderedIndexById = new Map(orderedSteps.map((step, index) => [step.id, index]));
  const connectors: FlowDiagramConnector[] = nodes.flatMap((from) => {
    const explicitNext = nextTargets(from.step.next);
    const titledNext =
      explicitNext === null ? targetStepsByTitle(from.step.next, orderedSteps, from.step) : [];
    const nextIndex = orderedIndexById.get(from.step.id) ?? -1;
    const fallbackNext =
      explicitNext === null && titledNext.length === 0 && nextIndex >= 0
        ? orderedSteps[nextIndex + 1]
        : undefined;
    const resolvedNext =
      explicitNext ??
      (titledNext.length
        ? titledNext
        : String(from.step.next || '').trim() && !isTerminalNext(from.step.next) && fallbackNext
          ? [fallbackNext.n]
          : []);
    const targets = new Set<number>([...resolvedNext, ...branchTargets(from.step.branch)]);
    return [...targets].flatMap((number) => {
      const to = nodeByNumber.get(number);
      if (!to) return [];
      const detour = to.step.n !== from.step.n + 1;
      const path = detour
        ? from.flowRow === to.flowRow
          ? `M ${from.x + from.width / 2} ${from.y} V ${Math.min(from.y, to.y) - 10} H ${to.x + to.width / 2} V ${to.y}`
          : crossRowDetourPath(from, to)
        : from.flowRow === to.flowRow
          ? connectorPath(from, to)
          : rowConnectorPath(from, to);
      return [{ fromStepId: from.step.id, toStepId: to.step.id, path }];
    });
  });

  const contentRight = Math.max(
    FLOW_DIAGRAM_TRACK_START,
    ...nodes.map((node) => node.x + node.width),
  );
  const terminalPadding = nodes.length
    ? nodes[nodes.length - 1].flowDirection > 0
      ? FLOW_DIAGRAM_TRACK_END
      : 12
    : FLOW_DIAGRAM_TRACK_END;

  return {
    width: contentRight + terminalPadding,
    height: laneY + FLOW_DIAGRAM_TOP,
    lanes,
    nodes,
    connectors,
  };
}
