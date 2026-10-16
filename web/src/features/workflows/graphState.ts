import {
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_TYPES,
  type NodeCatalogEntry,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowHandle,
  type WorkflowNode,
  type WorkflowNodeType,
} from '@asf/shared';

/** Undo stack depth (WORKFLOW_ENGINE_SPEC.md §9). */
export const HISTORY_LIMIT = 100;

export interface Position {
  x: number;
  y: number;
}

/**
 * Immutable editing model of a workflow graph. Every function below returns a new state, or the same object when
 * nothing changed. `clipboardEdges` (the edges between the copied nodes) and `dragBase` (the graph before a drag
 * started) are internal additions to the documented shape: without them paste could not keep internal edges after
 * the originals are deleted, and undo of a drag would not return to the pre-drag position.
 */
export interface EditorState {
  graph: WorkflowGraph;
  /** Selected node ids. */
  selection: string[];
  past: WorkflowGraph[];
  future: WorkflowGraph[];
  clipboard: WorkflowNode[];
  clipboardEdges: WorkflowEdge[];
  dirty: boolean;
  dragBase?: WorkflowGraph;
}

export interface ConnectInput {
  source: string;
  sourceHandle?: WorkflowHandle;
  target: string;
}

export interface ConnectResult {
  state: EditorState;
  error?: string;
}

export interface NodePatch {
  label?: string;
  /** Merged into the node's config; a key set to `undefined` is removed. */
  config?: Record<string, unknown>;
}

// ------------------------------------------------------------------ helpers

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function edgeId(source: string, handle: WorkflowHandle | undefined, target: string): string {
  return `${source}${handle && handle !== 'out' ? `:${handle}` : ''}->${target}`;
}

/** `type-n` with the smallest n not in `used` (always matches /^[a-z0-9-]{1,40}$/ for a catalog type). */
function freshId(type: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function cloneNode(node: WorkflowNode): WorkflowNode {
  return { ...node, position: { ...node.position }, config: cloneJson(node.config) };
}

function cloneEdge(edge: WorkflowEdge): WorkflowEdge {
  return { ...edge };
}

function pushHistory(past: WorkflowGraph[], graph: WorkflowGraph): WorkflowGraph[] {
  const next = [...past, graph];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** A recorded change: the previous graph goes on the undo stack, redo is cleared, the state becomes dirty. */
function commit(state: EditorState, graph: WorkflowGraph, selection: string[] = state.selection): EditorState {
  return {
    ...state,
    graph,
    selection,
    past: pushHistory(state.past, state.dragBase ?? state.graph),
    future: [],
    dirty: true,
    dragBase: undefined,
  };
}

const keepExisting = (graph: WorkflowGraph, ids: string[]): string[] => {
  const present = new Set(graph.nodes.map((node) => node.id));
  return ids.filter((id) => present.has(id));
};

function defaultConfig(entry: NodeCatalogEntry | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of entry?.fields ?? []) {
    if (field.default !== undefined) config[field.key] = field.default;
  }
  return config;
}

// ------------------------------------------------------------------ state

export function createEditorState(graph: WorkflowGraph): EditorState {
  return { graph, selection: [], past: [], future: [], clipboard: [], clipboardEdges: [], dirty: false };
}

export function replaceGraph(state: EditorState, graph: WorkflowGraph, options: { dirty?: boolean } = {}): EditorState {
  return { ...createEditorState(graph), clipboard: state.clipboard, clipboardEdges: state.clipboardEdges, dirty: options.dirty ?? false };
}

export function markSaved(state: EditorState): EditorState {
  return state.dirty ? { ...state, dirty: false } : state;
}

// ------------------------------------------------------------------ nodes

export function addNode(state: EditorState, type: WorkflowNodeType, position: Position, catalog?: NodeCatalogEntry[]): EditorState {
  const used = new Set(state.graph.nodes.map((node) => node.id));
  const id = freshId(type, used);
  const node: WorkflowNode = {
    id,
    type,
    position: { x: position.x, y: position.y },
    config: defaultConfig(catalog?.find((entry) => entry.type === type)),
  };
  return commit(state, { ...state.graph, nodes: [...state.graph.nodes, node] }, [id]);
}

function applyMoves(graph: WorkflowGraph, moves: { id: string; position: Position }[]): WorkflowGraph {
  const byId = new Map(moves.map((move) => [move.id, move.position]));
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    const target = byId.get(node.id);
    if (!target || (target.x === node.position.x && target.y === node.position.y)) return node;
    changed = true;
    return { ...node, position: { x: target.x, y: target.y } };
  });
  return changed ? { ...graph, nodes } : graph;
}

const samePositions = (a: WorkflowGraph, b: WorkflowGraph): boolean =>
  a.nodes.length === b.nodes.length &&
  a.nodes.every((node, i) => node.position.x === b.nodes[i].position.x && node.position.y === b.nodes[i].position.y);

/**
 * Drag ticks pass `record: false` (graph follows the pointer, no history entry); the drop passes `record: true` and
 * pushes the graph from before the drag as one undo step.
 */
export function moveNodes(state: EditorState, moves: { id: string; position: Position }[], options: { record: boolean }): EditorState {
  const graph = applyMoves(state.graph, moves);
  if (!options.record) {
    if (graph === state.graph) return state;
    return { ...state, graph, dragBase: state.dragBase ?? state.graph, dirty: true };
  }
  const base = state.dragBase ?? state.graph;
  if (samePositions(base, graph)) {
    if (graph === state.graph && !state.dragBase) return state;
    return { ...state, graph: base, dragBase: undefined };
  }
  return commit(state, graph);
}

export function updateNode(state: EditorState, id: string, patch: NodePatch): EditorState {
  const node = state.graph.nodes.find((candidate) => candidate.id === id);
  if (!node) return state;
  let next = node;
  if (patch.label !== undefined) {
    const label = patch.label === '' ? undefined : patch.label;
    if (label !== node.label) {
      const { label: _previous, ...rest } = next;
      next = label === undefined ? rest : { ...rest, label };
    }
  }
  if (patch.config) {
    const config: Record<string, unknown> = { ...next.config };
    for (const [key, value] of Object.entries(patch.config)) {
      if (value === undefined) delete config[key];
      else config[key] = value;
    }
    if (!sameJson(config, next.config)) next = { ...next, config };
  }
  if (next === node) return state;
  return commit(state, { ...state.graph, nodes: state.graph.nodes.map((candidate) => (candidate === node ? next : candidate)) });
}

export function deleteSelection(state: EditorState): EditorState {
  const doomed = new Set(keepExisting(state.graph, state.selection));
  if (doomed.size === 0) return state;
  const graph: WorkflowGraph = {
    ...state.graph,
    nodes: state.graph.nodes.filter((node) => !doomed.has(node.id)),
    edges: state.graph.edges.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target)),
  };
  return commit(state, graph, []);
}

// ------------------------------------------------------------------ edges

function connectError(state: EditorState, input: ConnectInput, catalog?: NodeCatalogEntry[]): string | null {
  const source = state.graph.nodes.find((node) => node.id === input.source);
  const target = state.graph.nodes.find((node) => node.id === input.target);
  if (!source || !target) return 'Both ends of a connection must be existing nodes.';
  if (source.id === target.id) return 'A node cannot be connected to itself.';
  const handle = input.sourceHandle ?? 'out';
  if (catalog) {
    const sourceEntry = catalog.find((entry) => entry.type === source.type);
    const targetEntry = catalog.find((entry) => entry.type === target.type);
    if (sourceEntry && !sourceEntry.handles.outputs.includes(handle)) {
      return `A ${sourceEntry.label} node has no "${handle}" output.`;
    }
    if (targetEntry && !targetEntry.handles.input) return `A ${targetEntry.label} node cannot have incoming connections.`;
  }
  const duplicate = state.graph.edges.some(
    (edge) => edge.source === source.id && edge.target === target.id && (edge.sourceHandle ?? 'out') === handle,
  );
  return duplicate ? 'These nodes are already connected.' : null;
}

export function connect(state: EditorState, input: ConnectInput, catalog?: NodeCatalogEntry[]): ConnectResult {
  const error = connectError(state, input, catalog);
  if (error) return { state, error };
  const source = state.graph.nodes.find((node) => node.id === input.source) as WorkflowNode;
  const handle = input.sourceHandle && input.sourceHandle !== 'out' ? input.sourceHandle : undefined;
  const edge: WorkflowEdge = { id: edgeId(input.source, handle, input.target), source: input.source, target: input.target };
  if (handle) edge.sourceHandle = handle;
  if (source.type === 'fix') edge.kind = 'retry';
  return { state: commit(state, { ...state.graph, edges: [...state.graph.edges, edge] }) };
}

export function deleteEdge(state: EditorState, id: string): EditorState {
  if (!state.graph.edges.some((edge) => edge.id === id)) return state;
  return commit(state, { ...state.graph, edges: state.graph.edges.filter((edge) => edge.id !== id) });
}

// ------------------------------------------------------------------ selection and clipboard

export function select(state: EditorState, ids: string[]): EditorState {
  const next = [...new Set(keepExisting(state.graph, ids))];
  return sameJson(next, state.selection) ? state : { ...state, selection: next };
}

export function selectAll(state: EditorState): EditorState {
  return select(state, state.graph.nodes.map((node) => node.id));
}

export function copy(state: EditorState): EditorState {
  const chosen = new Set(keepExisting(state.graph, state.selection));
  if (chosen.size === 0) return state;
  return {
    ...state,
    clipboard: state.graph.nodes.filter((node) => chosen.has(node.id)).map(cloneNode),
    clipboardEdges: state.graph.edges.filter((edge) => chosen.has(edge.source) && chosen.has(edge.target)).map(cloneEdge),
  };
}

export function paste(state: EditorState, offset: Position): EditorState {
  if (state.clipboard.length === 0) return state;
  const used = new Set(state.graph.nodes.map((node) => node.id));
  const remap = new Map<string, string>();
  const nodes = state.clipboard.map((node) => {
    const id = freshId(node.type, used);
    used.add(id);
    remap.set(node.id, id);
    const copied = cloneNode(node);
    return { ...copied, id, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } };
  });
  const edges: WorkflowEdge[] = [];
  for (const edge of state.clipboardEdges) {
    const source = remap.get(edge.source);
    const target = remap.get(edge.target);
    if (!source || !target) continue;
    edges.push({ ...edge, id: edgeId(source, edge.sourceHandle, target), source, target });
  }
  const graph: WorkflowGraph = { ...state.graph, nodes: [...state.graph.nodes, ...nodes], edges: [...state.graph.edges, ...edges] };
  return commit(state, graph, nodes.map((node) => node.id));
}

// ------------------------------------------------------------------ history

export function undo(state: EditorState): EditorState {
  if (state.past.length === 0) return state;
  const graph = state.past[state.past.length - 1];
  return {
    ...state,
    graph,
    selection: keepExisting(graph, state.selection),
    past: state.past.slice(0, -1),
    future: [...state.future, state.dragBase ?? state.graph],
    dirty: true,
    dragBase: undefined,
  };
}

export function redo(state: EditorState): EditorState {
  if (state.future.length === 0) return state;
  const graph = state.future[state.future.length - 1];
  return {
    ...state,
    graph,
    selection: keepExisting(graph, state.selection),
    past: pushHistory(state.past, state.graph),
    future: state.future.slice(0, -1),
    dirty: true,
    dragBase: undefined,
  };
}

// ------------------------------------------------------------------ import

export type ParseResult ={ graph: WorkflowGraph } | { error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const HANDLES: readonly string[] = ['out', 'pass', 'fail'];

function parseNode(raw: unknown, index: number): WorkflowNode | string {
  if (!isObject(raw)) return `Node ${index + 1} is not an object.`;
  const { id, type, label, position, config } = raw;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) return `Node ${index + 1} has an invalid id (use a-z, 0-9 and "-", up to 40 characters).`;
  if (typeof type !== 'string' || !(WORKFLOW_NODE_TYPES as readonly string[]).includes(type)) return `Node "${id}" has an unknown type.`;
  if (!isObject(position) || !isNumber(position.x) || !isNumber(position.y)) return `Node "${id}" has an invalid position.`;
  if (config !== undefined && !isObject(config)) return `Node "${id}" has an invalid config.`;
  if (label !== undefined && typeof label !== 'string') return `Node "${id}" has an invalid label.`;
  const node: WorkflowNode = { id, type: type as WorkflowNodeType, position: { x: position.x, y: position.y }, config: cloneJson(config ?? {}) };
  if (label) node.label = label as string;
  return node;
}

function parseEdge(raw: unknown, index: number): WorkflowEdge | string {
  if (!isObject(raw)) return `Edge ${index + 1} is not an object.`;
  const { id, source, target, sourceHandle, kind } = raw;
  if (typeof id !== 'string' || !id || typeof source !== 'string' || typeof target !== 'string') return `Edge ${index + 1} needs an id, a source and a target.`;
  if (sourceHandle !== undefined && (typeof sourceHandle !== 'string' || !HANDLES.includes(sourceHandle))) return `Edge "${id}" has an invalid source handle.`;
  if (kind !== undefined && kind !== 'normal' && kind !== 'retry') return `Edge "${id}" has an invalid kind.`;
  const edge: WorkflowEdge = { id, source, target };
  if (sourceHandle) edge.sourceHandle = sourceHandle as WorkflowHandle;
  if (kind) edge.kind = kind as 'normal' | 'retry';
  return edge;
}

function parseList<T>(raw: unknown, parse: (item: unknown, index: number) => T | string): T[] | string {
  if (!Array.isArray(raw)) return 'The graph needs "nodes" and "edges" arrays.';
  const out: T[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parse(item, index);
    if (typeof parsed === 'string') return parsed;
    out.push(parsed);
  }
  return out;
}

/**
 * Shape check of an imported file: a bare graph or an exported workflow (`{ graph }`). The server validates the
 * graph fully; this only keeps a malformed file from reaching the canvas.
 */
export function parseWorkflowJson(text: string): ParseResult {
  if (text.length > WORKFLOW_LIMITS.maxGraphBytes) return { error: 'The file is larger than the 200 KB graph limit.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'The file is not valid JSON.' };
  }
  const raw = isObject(data) && isObject(data.graph) ? data.graph : data;
  if (!isObject(raw)) return { error: 'The file does not contain a workflow graph.' };
  if (raw.schemaVersion !== 1) return { error: 'Unsupported graph schemaVersion (expected 1).' };
  const nodes = parseList(raw.nodes, parseNode);
  if (typeof nodes === 'string') return { error: nodes };
  const edges = parseList(raw.edges, parseEdge);
  if (typeof edges === 'string') return { error: edges };
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { error: `Node id "${node.id}" is used twice.` };
    ids.add(node.id);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) return { error: `Edge "${edge.id}" points to a missing node.` };
  }
  return { graph: { schemaVersion: 1, nodes, edges } };
}
