import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { BusinessFlow, BusinessFunction } from '../../lib/business-map';
import {
  buildBusinessFlowDiagram,
  FLOW_DIAGRAM_COLUMN_GAP,
  FLOW_DIAGRAM_MAX_ZOOM,
  FLOW_DIAGRAM_MIN_ZOOM,
  FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH,
  FLOW_DIAGRAM_TERMINAL_GAP,
  FLOW_DIAGRAM_ZOOM_STEP,
  normalizeFlowDiagramZoom,
  type BusinessFlowLaneMode,
} from '../../lib/business-flow-diagram';
import { readBusinessFlowZoom, writeBusinessFlowZoom } from '../../lib/business-map-memory';
import OverflowHint from './OverflowHint';
import { PmIcon } from './PmShared';

export default function BusinessFlowDiagram({
  flow,
  functions,
  laneMode,
  selectedStepId,
  detailOpen,
  onSelectStep,
  onAddStep,
}: {
  flow: BusinessFlow;
  functions: BusinessFunction[];
  laneMode: BusinessFlowLaneMode;
  selectedStepId: string;
  detailOpen: boolean;
  onSelectStep: (stepId: string) => void;
  onAddStep: (afterStepId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousFlowIdRef = useRef('');
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(() => readBusinessFlowZoom(flow.id));
  const zoomRef = useRef(zoom);
  const [selectedConnectorKey, setSelectedConnectorKey] = useState('');
  const rawId = useId();
  const arrowId = `bm-flow-arrow-${rawId.replaceAll(':', '')}`;
  const layout = useMemo(() => buildBusinessFlowDiagram(flow, laneMode), [flow, laneMode]);
  const selectedNode = layout.nodes.find((node) => node.step.id === selectedStepId);
  const firstNode = layout.nodes[0];
  const lastNode = layout.nodes[layout.nodes.length - 1];
  const functionById = useMemo(
    () => new Map(functions.map((item) => [item.id, item])),
    [functions],
  );
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.step.id, node])),
    [layout.nodes],
  );
  const connectedStepPairs = useMemo(
    () =>
      new Set(
        layout.connectors.map((connector) => `${connector.fromStepId}>${connector.toStepId}`),
      ),
    [layout.connectors],
  );

  function startCanvasDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.pointerType !== 'mouse') return;
    const container = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: container.scrollLeft,
      startScrollTop: container.scrollTop,
      moved: false,
    };
  }

  function moveCanvasDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    if (!drag.moved) return;
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.startScrollLeft - deltaX;
    event.currentTarget.scrollTop = drag.startScrollTop - deltaY;
  }

  function finishCanvasDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  function applyZoom(nextValue: number, clientX?: number, clientY?: number) {
    const container = scrollRef.current;
    if (!container) return;
    const nextZoom = normalizeFlowDiagramZoom(nextValue);
    const currentZoom = zoomRef.current;
    if (nextZoom === currentZoom) return;
    const rect = container.getBoundingClientRect();
    const anchorX = clientX ?? rect.left + container.clientWidth / 2;
    const anchorY = clientY ?? rect.top + container.clientHeight / 2;
    const offsetX = anchorX - rect.left;
    const offsetY = anchorY - rect.top;
    const contentX = (container.scrollLeft + offsetX) / currentZoom;
    const contentY = (container.scrollTop + offsetY) / currentZoom;

    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    writeBusinessFlowZoom(flow.id, nextZoom);
    window.requestAnimationFrame(() => {
      const current = scrollRef.current;
      if (!current) return;
      current.scrollLeft = contentX * nextZoom - offsetX;
      current.scrollTop = contentY * nextZoom - offsetY;
    });
  }

  useEffect(() => {
    const rememberedZoom = readBusinessFlowZoom(flow.id);
    zoomRef.current = rememberedZoom;
    setZoom(rememberedZoom);
    setSelectedConnectorKey('');
  }, [flow.id]);

  useEffect(() => {
    setSelectedConnectorKey('');
  }, [laneMode]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !selectedStepId) return;
    if (previousFlowIdRef.current !== flow.id) {
      previousFlowIdRef.current = flow.id;
      container.scrollLeft = 0;
      return;
    }
    let timer = 0;
    const revealSelected = () => {
      const node = container.querySelector<HTMLElement>(`[data-flow-step-id="${selectedStepId}"]`);
      if (!node) return;
      const rail = container.querySelector<HTMLElement>('.tw-bm-flow-lane-rail');
      const containerRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const safeLeft = containerRect.left + (rail?.getBoundingClientRect().width || 0) + 20;
      const safeRight = containerRect.right - 20;
      if (nodeRect.left >= safeLeft && nodeRect.right <= safeRight) return;
      const delta =
        nodeRect.left < safeLeft ? nodeRect.left - safeLeft : nodeRect.right - safeRight;
      container.scrollTo({
        left: Math.max(0, container.scrollLeft + delta),
        behavior: 'smooth',
      });
    };
    revealSelected();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(revealSelected, 120);
          });
    observer?.observe(container);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [flow.id, selectedStepId, laneMode]);

  return (
    <div className="tw-bm-flow-canvas-wrap">
      <div
        ref={scrollRef}
        className={`tw-bm-flow-canvas-scroll ${dragging ? 'is-dragging' : ''}`}
        tabIndex={0}
        aria-label="业务流程泳道图，可按住鼠标拖动或横向、纵向滚动查看"
        onPointerDown={startCanvasDrag}
        onPointerMove={moveCanvasDrag}
        onPointerUp={finishCanvasDrag}
        onPointerCancel={finishCanvasDrag}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          if ((event.target as Element).closest('.tw-bm-flow-link')) return;
          setSelectedConnectorKey('');
        }}
      >
        <div className="tw-bm-flow-canvas-shell" style={{ height: layout.height * zoom }}>
          <div className="tw-bm-flow-lane-rail" aria-hidden="true">
            {layout.lanes.map((lane) => (
              <div
                key={lane.key}
                className={`tw-bm-flow-lane-label ${
                  selectedNode?.laneIndex === lane.index ? 'active' : ''
                }`}
                style={{ top: lane.y * zoom, height: lane.height * zoom }}
              >
                <span>{String(lane.index + 1).padStart(2, '0')}</span>
                <strong>
                  <OverflowHint text={lane.label} clamp="y" />
                </strong>
                <small>{lane.stepCount} 步</small>
              </div>
            ))}
          </div>

          <div
            className="tw-bm-flow-track-viewport"
            style={{ width: layout.width * zoom, height: layout.height * zoom }}
          >
            <div
              className="tw-bm-flow-track"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${zoom})`,
              }}
            >
              {layout.lanes.map((lane) => (
                <div
                  key={lane.key}
                  className={`tw-bm-flow-lane-band ${lane.index % 2 ? 'is-alt' : ''}`}
                  style={{ top: lane.y, height: lane.height }}
                />
              ))}

              <svg
                className="tw-bm-flow-connectors"
                width={layout.width}
                height={layout.height}
                role="group"
                aria-label="流程连线，可点击高亮流向"
              >
                <defs>
                  <marker
                    id={arrowId}
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                  >
                    <path d="M 0 0 L 7 3.5 L 0 7 Z" className="tw-bm-flow-arrow" />
                  </marker>
                </defs>
                {firstNode ? (
                  <path
                    className="tw-bm-flow-connector start"
                    d={`M ${
                      firstNode.x - FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH
                    } ${firstNode.y + firstNode.height / 2} H ${firstNode.x}`}
                    markerEnd={`url(#${arrowId})`}
                  />
                ) : null}
                {layout.connectors.map((connector) => {
                  const fromNode = nodeById.get(connector.fromStepId);
                  const toNode = nodeById.get(connector.toStepId);
                  if (!fromNode || !toNode) return null;
                  const connectorKey = `${connector.fromStepId}-${connector.toStepId}`;
                  const active = selectedConnectorKey === connectorKey;
                  const label = `第 ${fromNode.step.n} 步到第 ${toNode.step.n} 步的流向`;
                  return (
                    <g
                      key={connectorKey}
                      className={`tw-bm-flow-link ${active ? 'is-active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={label}
                      aria-pressed={active}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedConnectorKey(active ? '' : connectorKey);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setSelectedConnectorKey(active ? '' : connectorKey);
                      }}
                    >
                      <path className="tw-bm-flow-connector-hit" d={connector.path} />
                      <path
                        className={`tw-bm-flow-connector ${active ? 'is-active' : ''}`}
                        d={connector.path}
                        markerEnd={`url(#${arrowId})`}
                      />
                      {active ? (
                        <path className="tw-bm-flow-connector-pulse" d={connector.path} />
                      ) : null}
                    </g>
                  );
                })}
                {lastNode ? (
                  <path
                    className="tw-bm-flow-connector end"
                    d={
                      lastNode.flowDirection > 0
                        ? `M ${lastNode.x + lastNode.width} ${lastNode.y + lastNode.height / 2} H ${
                            lastNode.x + lastNode.width + FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH
                          }`
                        : `M ${lastNode.x} ${lastNode.y + lastNode.height / 2} H ${
                            lastNode.x - FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH
                          }`
                    }
                    markerEnd={`url(#${arrowId})`}
                  />
                ) : null}
              </svg>

              {firstNode ? (
                <span
                  className="tw-bm-flow-terminal start"
                  style={{ top: firstNode.y + firstNode.height / 2 - 13 }}
                >
                  开始
                </span>
              ) : null}

              {layout.nodes.map((node) => {
                const step = node.step;
                const fnItem = functionById.get(step.functionId);
                const role = step.role.trim() || '未标注角色';
                const system = step.system.trim() || '未标注参与系统';
                const dependencyText = step.dependencies
                  .map((dependency) => `${dependency.system}：${dependency.label}`)
                  .join('\n');
                return (
                  <button
                    key={step.id}
                    type="button"
                    data-flow-step-id={step.id}
                    aria-current={selectedStepId === step.id ? 'step' : undefined}
                    aria-controls="business-flow-step-detail"
                    aria-expanded={selectedStepId === step.id ? detailOpen : false}
                    aria-label={`第 ${step.n} 步：${step.title}，${role}，${system}`}
                    className={`tw-bm-flow-node ${selectedStepId === step.id ? 'active' : ''} ${
                      step.manual ? 'manual' : ''
                    }`}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: node.width,
                      height: node.height,
                    }}
                    onClick={() => onSelectStep(step.id)}
                  >
                    <span className="tw-bm-flow-node-head">
                      <span className="tw-bm-flow-node-index">{step.n}</span>
                      <span className={`tw-bm-flow-node-kind ${step.manual ? 'manual' : ''}`}>
                        {step.manual ? '人工环节' : '系统动作'}
                      </span>
                      <span className="tw-bm-flow-node-edit">查看</span>
                    </span>
                    <strong className="tw-bm-flow-node-title">
                      <OverflowHint text={step.title} clamp="y" />
                    </strong>
                    <span className="tw-bm-flow-node-function">
                      <OverflowHint
                        text={fnItem ? `${fnItem.code} · ${fnItem.name}` : '未关联功能'}
                        className="tw-bm-flow-node-function-text"
                      />
                    </span>
                    <span className="tw-bm-flow-node-actor">
                      <OverflowHint text={role} className="tw-bm-flow-node-role" />
                      <i aria-hidden="true" />
                      <OverflowHint text={system} className="tw-bm-flow-node-system" />
                    </span>
                    <span className="tw-bm-flow-node-io">
                      <span>
                        <b>入</b>
                        <OverflowHint text={step.input || '未填写输入'} />
                      </span>
                      <span>
                        <b>出</b>
                        <OverflowHint text={step.output || '未填写输出'} />
                      </span>
                    </span>
                    <span className="tw-bm-flow-node-signals">
                      <span className="tw-bm-flow-node-next">
                        <b>下一步</b>
                        <OverflowHint text={step.next || '未设置'} />
                      </span>
                      {step.branch ? (
                        <span
                          className={`tw-bm-flow-node-flag ${step.branchBroken ? 'warn' : 'ok'}`}
                        >
                          <OverflowHint
                            text={step.branch}
                            displayText={`${step.branchBroken ? '分支待连接' : '分支'} · ${step.branch}`}
                          />
                        </span>
                      ) : null}
                      {step.dependencies.length ? (
                        <span className="tw-bm-flow-node-flag dependency">
                          <OverflowHint
                            text={dependencyText}
                            displayText={`系统依赖 ${step.dependencies.length}`}
                          />
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}

              {layout.nodes.slice(0, -1).map((node, index) => {
                const next = layout.nodes[index + 1];
                if (!connectedStepPairs.has(`${node.step.id}>${next.step.id}`)) return null;
                const rowBreak = node.flowRow !== next.flowRow;
                const movingRight = next.x > node.x;
                const left = rowBreak
                  ? node.x + node.width / 2 - 13
                  : movingRight
                    ? node.x + node.width + FLOW_DIAGRAM_COLUMN_GAP / 2 - 13
                    : node.x - FLOW_DIAGRAM_COLUMN_GAP / 2 - 13;
                const top = rowBreak
                  ? (node.y + node.height + next.y) / 2 - 13
                  : (node.y + node.height / 2 + next.y + next.height / 2) / 2 - 13;
                return (
                  <button
                    key={`insert-${node.step.id}`}
                    type="button"
                    className="tw-bm-flow-insert"
                    style={{ left, top }}
                    aria-label={`在第 ${node.step.n} 步后添加步骤`}
                    title={`在第 ${node.step.n} 步后添加步骤`}
                    onClick={() => onAddStep(node.step.id)}
                  >
                    <PmIcon name="plus" size={13} />
                  </button>
                );
              })}

              {lastNode ? (
                <span
                  className={`tw-bm-flow-terminal end ${lastNode.flowDirection < 0 ? 'is-left' : ''}`}
                  style={{
                    left:
                      lastNode.flowDirection > 0
                        ? lastNode.x +
                          lastNode.width +
                          FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH +
                          FLOW_DIAGRAM_TERMINAL_GAP
                        : lastNode.x -
                          FLOW_DIAGRAM_TERMINAL_CONNECTOR_LENGTH -
                          FLOW_DIAGRAM_TERMINAL_GAP,
                    top: lastNode.y + lastNode.height / 2 - 13,
                  }}
                >
                  结束
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <div className="tw-bm-flow-zoom-controls" role="group" aria-label="流程图缩放">
        <button
          type="button"
          aria-label="缩小流程图"
          title="缩小"
          disabled={zoom <= FLOW_DIAGRAM_MIN_ZOOM}
          onClick={() => applyZoom(zoomRef.current - FLOW_DIAGRAM_ZOOM_STEP)}
        >
          −
        </button>
        <button
          type="button"
          className="tw-bm-flow-zoom-value"
          aria-label={`当前缩放 ${Math.round(zoom * 100)}%，点击恢复 100%`}
          title="恢复 100%"
          onClick={() => applyZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="放大流程图"
          title="放大"
          disabled={zoom >= FLOW_DIAGRAM_MAX_ZOOM}
          onClick={() => applyZoom(zoomRef.current + FLOW_DIAGRAM_ZOOM_STEP)}
        >
          +
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {selectedConnectorKey ? '已突出显示所选流程连线及其流向' : ''}
      </span>
    </div>
  );
}
