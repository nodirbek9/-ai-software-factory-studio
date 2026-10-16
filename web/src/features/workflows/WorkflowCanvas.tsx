import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type KeyboardEvent,
} from 'react';
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeMouseHandler, type NodeChange, type NodeMouseHandler, type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  WORKFLOW_NODE_TYPES,
  type NodeCatalogEntry,
  type RunNodeStatus,
  type WorkflowHandle,
  type WorkflowIssue,
  type WorkflowNodeType,
} from '@asf/shared';
import {
  addNode, connect, copy, deleteEdge, deleteSelection, moveNodes, paste, redo, select, selectAll, undo,
  type EditorState, type Position,
} from './graphState';
import { NODE_DRAG_TYPE } from './NodePalette';
import { WorkflowNodeCard, nodeHue, type WorkflowFlowNode, type WorkflowNodeData } from './WorkflowNodeCard';

export interface WorkflowCanvasProps {
  state: EditorState;
  catalog: NodeCatalogEntry[];
  /** Live run status per node id (run view); absent while editing. */
  nodeStatus?: Record<string, RunNodeStatus>;
  issues?: WorkflowIssue[];
  /** Built-in templates: pan, zoom and select only. */
  readOnly?: boolean;
  onChange: (state: EditorState) => void;
  /** Selected connection. Optional: without it the canvas keeps the edge selection itself. */
  selectedEdgeId?: string | null;
  onSelectEdge?: (id: string | null) => void;
}

/** What the page's toolbar and palette can ask of the canvas. */
export interface WorkflowCanvasHandle {
  addNodeAtCenter: (type: WorkflowNodeType) => void;
  fitView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const nodeTypes = { workflow: WorkflowNodeCard };

const NODE_SIZE = { width: 200, height: 64 };
const PASTE_STEP = 40;
const ERROR_VISIBLE_MS = 6000;
const HANDLES: readonly string[] = ['out', 'pass', 'fail'];
const FIT_OPTIONS = { padding: 0.15, maxZoom: 1 };

const isNodeType = (value: string): value is WorkflowNodeType => (WORKFLOW_NODE_TYPES as readonly string[]).includes(value);
const toHandle = (value: string | null | undefined): WorkflowHandle | undefined =>
  value && HANDLES.includes(value) ? (value as WorkflowHandle) : undefined;

function isEditable(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

interface Size {
  width: number;
  height: number;
}

/** `previous` itself when no size changed, so a re-measure that reports the same sizes causes no render. */
function mergeSizes(previous: Record<string, Size>, update: Record<string, Size>): Record<string, Size> {
  const changed = Object.entries(update).filter(([id, size]) => previous[id]?.width !== size.width || previous[id]?.height !== size.height);
  return changed.length === 0 ? previous : { ...previous, ...Object.fromEntries(changed) };
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (id !== undefined) groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
}

/** The first spot at or below `at` (diagonally) where no node already sits, so repeated adds do not stack. */
function freeSpot(state: EditorState, at: Position): Position {
  let spot = { ...at };
  while (state.graph.nodes.some((node) => Math.abs(node.position.x - spot.x) < 8 && Math.abs(node.position.y - spot.y) < 8)) {
    spot = { x: spot.x + 24, y: spot.y + 24 };
  }
  return spot;
}

function edgeColor(sourceHandle: WorkflowHandle | undefined, retry: boolean, issue: WorkflowIssue | undefined): string {
  if (issue) return issue.severity === 'error' ? 'var(--color-st-failed)' : 'var(--color-st-waiting)';
  if (sourceHandle === 'pass') return 'var(--color-st-completed)';
  if (sourceHandle === 'fail') return 'var(--color-st-failed)';
  return retry ? 'var(--color-st-waiting)' : 'var(--color-faint)';
}

// ------------------------------------------------------------------ canvas

const CanvasInner = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(function CanvasInner(props, ref) {
  const { state, catalog, nodeStatus, issues, readOnly = false, onChange, onSelectEdge } = props;
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // Events of one tick (position + selection changes) must build on each other, not on the same stale props.
  const latest = useRef(state);
  latest.current = state;
  const pasteStep = useRef(1);
  const [localEdge, setLocalEdge] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // A controlled flow must feed the measured node sizes back, or its nodes are re-created without them and stay hidden.
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const selectedEdge = props.selectedEdgeId !== undefined ? props.selectedEdgeId : localEdge;

  useEffect(() => {
    if (!connectError) return undefined;
    const timer = setTimeout(() => setConnectError(null), ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [connectError]);

  const emit = useCallback((next: EditorState): void => {
    if (next === latest.current) return;
    latest.current = next;
    onChange(next);
  }, [onChange]);

  const setEdge = useCallback((id: string | null): void => {
    setLocalEdge(id);
    onSelectEdge?.(id);
  }, [onSelectEdge]);

  // ---- derived flow elements
  const entries = useMemo(() => new Map(catalog.map((entry) => [entry.type, entry])), [catalog]);
  const nodeIssues = useMemo(() => groupBy(issues ?? [], (issue) => issue.nodeId), [issues]);
  const edgeIssues = useMemo(() => groupBy(issues ?? [], (issue) => issue.edgeId), [issues]);

  const nodes = useMemo<WorkflowFlowNode[]>(() => {
    const selected = new Set(state.selection);
    return state.graph.nodes.map((node) => ({
      id: node.id,
      type: 'workflow',
      position: node.position,
      selected: selected.has(node.id),
      draggable: !readOnly,
      connectable: !readOnly,
      deletable: false,
      measured: sizes[node.id],
      data: { node, entry: entries.get(node.type), status: nodeStatus?.[node.id], issues: nodeIssues.get(node.id) ?? [] },
    }));
  }, [state.graph.nodes, state.selection, entries, nodeStatus, nodeIssues, readOnly, sizes]);

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(state.graph.nodes.map((node) => [node.id, node]));
    return state.graph.edges.map((edge) => {
      const source = byId.get(edge.source);
      const handle = toHandle(edge.sourceHandle) ?? (source ? entries.get(source.type)?.handles.outputs[0] : undefined);
      const retry = edge.kind === 'retry';
      const issue = edgeIssues.get(edge.id)?.[0];
      const color = edgeColor(toHandle(edge.sourceHandle), retry, issue);
      const isSelected = edge.id === selectedEdge;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: handle,
        selected: isSelected,
        deletable: false,
        label: retry ? 'retry' : undefined,
        labelStyle: { fill: color, fontSize: 10 },
        labelBgStyle: { fill: 'var(--color-ink-900)' },
        style: { stroke: color, strokeWidth: isSelected ? 2.8 : 1.6, strokeDasharray: retry ? '6 4' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
  }, [state.graph.nodes, state.graph.edges, entries, edgeIssues, selectedEdge]);

  // ---- node placement
  const place = useCallback((type: WorkflowNodeType, at: Position): void => {
    const entry = entries.get(type);
    if (readOnly || (entry && !entry.executable)) return;
    const centred = { x: at.x - NODE_SIZE.width / 2, y: at.y - NODE_SIZE.height / 2 };
    emit(addNode(latest.current, type, freeSpot(latest.current, centred), catalog));
    setEdge(null);
  }, [entries, readOnly, emit, catalog, setEdge]);

  useImperativeHandle(ref, () => ({
    addNodeAtCenter: (type) => {
      const rect = wrapper.current?.getBoundingClientRect();
      const screen = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
      place(type, flow.screenToFlowPosition(screen));
    },
    fitView: () => { void flow.fitView({ ...FIT_OPTIONS, duration: 200 }); },
    zoomIn: () => { void flow.zoomIn({ duration: 150 }); },
    zoomOut: () => { void flow.zoomOut({ duration: 150 }); },
  }), [flow, place]);

  // ---- flow events
  const onNodesChange = useCallback((changes: NodeChange<WorkflowFlowNode>[]): void => {
    const moves: { id: string; position: Position }[] = [];
    const measuredNow: Record<string, Size> = {};
    let selection: Set<string> | null = null;
    for (const change of changes) {
      if (change.type === 'position' && change.position && !readOnly) {
        moves.push({ id: change.id, position: change.position });
      } else if (change.type === 'select') {
        selection ??= new Set(latest.current.selection);
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      } else if (change.type === 'dimensions' && change.dimensions) {
        measuredNow[change.id] = change.dimensions;
      }
    }
    if (Object.keys(measuredNow).length > 0) setSizes((previous) => mergeSizes(previous, measuredNow));
    let next = latest.current;
    if (moves.length > 0) next = moveNodes(next, moves, { record: false });
    if (selection) {
      if (selection.size > 0) setEdge(null);
      next = select(next, [...selection]);
    }
    emit(next);
  }, [readOnly, emit, setEdge]);

  const onNodeDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>((_event, _node, dragged) => {
    emit(moveNodes(latest.current, dragged.map((node) => ({ id: node.id, position: node.position })), { record: true }));
  }, [emit]);

  const onConnect = useCallback((connection: Connection): void => {
    if (readOnly) return;
    const result = connect(latest.current, { source: connection.source, target: connection.target, sourceHandle: toHandle(connection.sourceHandle) }, catalog);
    setConnectError(result.error ?? null);
    if (!result.error) emit(result.state);
  }, [readOnly, catalog, emit]);

  const onEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => {
    emit(select(latest.current, []));
    setEdge(edge.id);
  }, [emit, setEdge]);

  const onNodeClick = useCallback<NodeMouseHandler>(() => setEdge(null), [setEdge]);

  const onPaneClick = useCallback((): void => {
    emit(select(latest.current, []));
    setEdge(null);
    setConnectError(null);
    wrapper.current?.focus({ preventScroll: true });
  }, [emit, setEdge]);

  // ---- palette drop
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (readOnly || !Array.from(event.dataTransfer.types).includes(NODE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    const type = event.dataTransfer.getData(NODE_DRAG_TYPE);
    if (readOnly || !isNodeType(type)) return;
    event.preventDefault();
    place(type, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  // ---- keyboard (the handler sits on the canvas wrapper, so it only sees keys while focus is inside it)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isEditable(event.target)) return;
    const current = latest.current;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let next: EditorState | null = null;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (readOnly) return;
      if (current.selection.length === 0 && selectedEdge) {
        next = deleteEdge(current, selectedEdge);
        setEdge(null);
      } else {
        next = deleteSelection(current);
      }
    } else if (mod && key === 'z') {
      if (readOnly) return;
      next = event.shiftKey ? redo(current) : undo(current);
    } else if (mod && key === 'y') {
      if (readOnly) return;
      next = redo(current);
    } else if (mod && key === 'c') {
      pasteStep.current = 1;
      next = copy(current);
    } else if (mod && key === 'v') {
      if (readOnly) return;
      next = paste(current, { x: PASTE_STEP * pasteStep.current, y: PASTE_STEP * pasteStep.current });
      pasteStep.current += 1;
    } else if (mod && key === 'a') {
      next = selectAll(current);
      setEdge(null);
    } else {
      return;
    }
    event.preventDefault();
    emit(next);
  };

  return (
    <div
      ref={wrapper}
      role="region"
      aria-label="Workflow canvas"
      tabIndex={0}
      className="relative h-full w-full outline-none"
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={() => setConnectError(null)}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_OPTIONS}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="#1e2b49" gap={22} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => nodeHue((node.data as WorkflowNodeData).entry)}
          maskColor="rgba(8, 13, 25, 0.7)"
          style={{ background: 'var(--color-ink-900)' }}
        />
      </ReactFlow>
      <div aria-live="polite" role="status" className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
        {connectError && (
          <span className="rounded-md border border-st-failed/40 bg-ink-900 px-3 py-1.5 text-[12px] text-st-failed shadow-lg">{connectError}</span>
        )}
      </div>
    </div>
  );
});

/** Controlled workflow editor canvas. Owns its own ReactFlowProvider; the page drives it through the ref handle. */
export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, WorkflowCanvasProps>(function WorkflowCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});
