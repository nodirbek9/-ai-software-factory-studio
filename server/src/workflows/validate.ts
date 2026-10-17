import { z } from 'zod';
import {
  SLOT_DEPENDENCY, WORKFLOW_LIMITS, WORKFLOW_NODE_TYPES, type AgentRole, type ValidationResult, type WorkflowEdge,
  type WorkflowGraph, type WorkflowIssue, type WorkflowIssueCode, type WorkflowNode, type WorkflowNodeType,
} from '@asf/shared';
import { catalogEntry, checkFieldValue, configText, readNodeConfig } from './catalog.ts';

// Workflow validation (WORKFLOW_ENGINE_SPEC.md §6.1). Pure: everything it needs from the studio comes in `ctx`.
// The graph helpers below are shared with the compiler, so both read the graph the same way.

export interface ValidationContext {
  /** Provider availability per role; absent = not checked. */
  providers?: { role: AgentRole; available: boolean }[];
  /** Command allowlist check; absent = not checked. */
  isCommandAllowed?: (command: string) => boolean;
}

const NODE_ID = /^[a-z0-9-]{1,40}$/;
/** Runtime fix tasks are keyed `fix-<key>-<round>` (fixLoop.ts); task nodes must not take such a key. */
const FIX_TASK_KEY = /^fix-.+-\d+$/;

/** Node types that compile to a task (backend/frontend only without a decompose node). */
export const TASK_NODE_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>([
  'architect', 'decompose', 'backend', 'frontend', 'qa', 'security', 'reviewer', 'approval', 'tool', 'artifact', 'notify',
]);
export const VERIFICATION_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>(['qa', 'security', 'reviewer']);

const graphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(z.object({
    id: z.string().regex(NODE_ID, 'node ids use a-z, 0-9 and "-" (1-40 characters)'),
    type: z.enum(WORKFLOW_NODE_TYPES),
    label: z.string().max(WORKFLOW_LIMITS.maxLabel, `labels are at most ${WORKFLOW_LIMITS.maxLabel} characters`).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    config: z.record(z.unknown()).default({}),
  })).max(WORKFLOW_LIMITS.maxNodes, `at most ${WORKFLOW_LIMITS.maxNodes} nodes`),
  edges: z.array(z.object({
    id: z.string().min(1).max(200),
    source: z.string().min(1),
    sourceHandle: z.enum(['out', 'pass', 'fail']).optional(),
    target: z.string().min(1),
    kind: z.enum(['normal', 'retry']).optional(),
  })).max(WORKFLOW_LIMITS.maxEdges, `at most ${WORKFLOW_LIMITS.maxEdges} edges`),
});

// ------------------------------------------------------------------ graph helpers (shared with compile.ts)

export interface GraphIndex {
  /** Node ids in graph order (first occurrence wins for duplicates). */
  ids: string[];
  nodes: Map<string, WorkflowNode>;
  /** Normal (non-retry) edges between existing nodes, self loops excluded. */
  normalIn: Map<string, WorkflowEdge[]>;
  normalOut: Map<string, WorkflowEdge[]>;
}

export function indexGraph(graph: WorkflowGraph): GraphIndex {
  const nodes = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
  const ids = [...nodes.keys()];
  const normalIn = new Map<string, WorkflowEdge[]>(ids.map((id) => [id, []]));
  const normalOut = new Map<string, WorkflowEdge[]>(ids.map((id) => [id, []]));
  for (const edge of graph.edges) {
    if (edge.kind === 'retry' || edge.source === edge.target || !nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    normalOut.get(edge.source)!.push(edge);
    normalIn.get(edge.target)!.push(edge);
  }
  return { ids, nodes, normalIn, normalOut };
}

/** Kahn's algorithm over normal edges; ties go to the node that comes first in the graph. */
export function topologicalOrder(index: GraphIndex): { order: string[]; cyclic: string[] } {
  const position = new Map(index.ids.map((id, i) => [id, i]));
  const inDegree = new Map(index.ids.map((id) => [id, index.normalIn.get(id)!.length]));
  const ready = index.ids.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const edge of index.normalOut.get(id)!) {
      const left = inDegree.get(edge.target)! - 1;
      inDegree.set(edge.target, left);
      if (left === 0) ready.push(edge.target);
    }
  }
  const done = new Set(order);
  return { order, cyclic: index.ids.filter((id) => !done.has(id)) };
}

function walk(start: string[], next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    for (const id of next(queue.shift()!)) {
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return seen;
}

/** Nodes reachable from `ids` over normal edges (the start nodes only if reached again). */
export function descendantsOf(index: GraphIndex, ids: string[]): Set<string> {
  return walk(ids, (id) => index.normalOut.get(id)!.map((e) => e.target));
}

export function ancestorsOf(index: GraphIndex, id: string): Set<string> {
  return walk([id], (current) => index.normalIn.get(current)!.map((e) => e.source));
}

export type NodeClass = 'task' | 'slot' | 'transparent';

/**
 * Keys of the nearest upstream task-producing nodes (WORKFLOW_ENGINE_SPEC.md §6.2): transparent nodes are walked
 * through, a 'slot' node yields SLOT_DEPENDENCY (its PM tasks are only known after the plan is expanded).
 */
export function taskDependencies(index: GraphIndex, nodeId: string, classify: (node: WorkflowNode) => NodeClass): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    for (const edge of index.normalIn.get(id) ?? []) {
      if (seen.has(edge.source)) continue;
      seen.add(edge.source);
      const source = index.nodes.get(edge.source)!;
      const kind = classify(source);
      if (kind === 'transparent') {
        visit(source.id);
        continue;
      }
      const key = kind === 'slot' ? SLOT_DEPENDENCY : source.id;
      if (!keys.includes(key)) keys.push(key);
    }
  };
  visit(nodeId);
  return keys;
}

export interface SlotLayout {
  /** The (first) decompose node; null = no dynamic expansion. */
  decomposeId: string | null;
  /** backend/frontend nodes, which are implementation slots when a decompose node exists. */
  slotIds: string[];
  /** The qa node right after the slots: it becomes V1's `qa-verify` rule. */
  qaVerifyId: string | null;
}

export function slotLayout(index: GraphIndex): SlotLayout {
  const all = index.ids.map((id) => index.nodes.get(id)!);
  const decomposeId = all.find((n) => n.type === 'decompose')?.id ?? null;
  if (!decomposeId) return { decomposeId: null, slotIds: [], qaVerifyId: null };
  const slotIds = all.filter((n) => n.type === 'backend' || n.type === 'frontend').map((n) => n.id);
  const qaVerifyId = all.find((n) => {
    const incoming = index.normalIn.get(n.id)!;
    return n.type === 'qa' && incoming.length > 0 && incoming.every((e) => slotIds.includes(e.source));
  })?.id ?? null;
  return { decomposeId, slotIds, qaVerifyId };
}

export function classifyNode(node: WorkflowNode, layout: SlotLayout): NodeClass {
  if (layout.decomposeId && (layout.slotIds.includes(node.id) || node.id === layout.qaVerifyId)) return 'slot';
  return TASK_NODE_TYPES.has(node.type) ? 'task' : 'transparent';
}

// ------------------------------------------------------------------ checks

class Issues {
  readonly list: WorkflowIssue[] = [];

  error(code: WorkflowIssueCode, message: string, where: { nodeId?: string; edgeId?: string } = {}): void {
    this.list.push({ code, severity: 'error', message, ...where });
  }

  warning(code: WorkflowIssueCode, message: string, where: { nodeId?: string; edgeId?: string } = {}): void {
    this.list.push({ code, severity: 'warning', message, ...where });
  }
}

const nameOf = (node: WorkflowNode): string => `"${node.label?.trim() || node.id}"`;

function itemId(raw: unknown, collection: unknown, index: unknown): string | undefined {
  if ((collection !== 'nodes' && collection !== 'edges') || typeof index !== 'number') return undefined;
  const items = (raw as Record<string, unknown> | null)?.[collection];
  const id = Array.isArray(items) ? (items[index] as Record<string, unknown> | null)?.id : undefined;
  return typeof id === 'string' ? id : undefined;
}

function parseGraph(raw: unknown, issues: Issues): WorkflowGraph | null {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '');
  } catch {
    issues.error('E_CONFIG', 'The workflow is not valid JSON data');
    return null;
  }
  if (bytes > WORKFLOW_LIMITS.maxGraphBytes) {
    issues.error('E_LIMIT', `The workflow is ${bytes} bytes; the limit is ${WORKFLOW_LIMITS.maxGraphBytes}`);
    return null;
  }
  const result = graphSchema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const [collection, index] = issue.path;
    const id = itemId(raw, collection, index);
    const where = collection === 'nodes' ? { nodeId: id } : collection === 'edges' ? { edgeId: id } : {};
    issues.error(issue.code === 'too_big' ? 'E_LIMIT' : 'E_CONFIG', `${issue.path.join('.') || 'workflow'}: ${issue.message}`, where);
  }
  return null;
}

function checkEdges(graph: WorkflowGraph, index: GraphIndex, issues: Issues): void {
  const seenNodes = new Set<string>();
  for (const node of graph.nodes) {
    if (seenNodes.has(node.id)) issues.error('E_EDGE', `Duplicate node id "${node.id}"`, { nodeId: node.id });
    seenNodes.add(node.id);
  }
  const seenEdges = new Set<string>();
  const connections = new Set<string>();
  for (const edge of graph.edges) {
    const at = { edgeId: edge.id };
    if (seenEdges.has(edge.id)) issues.error('E_EDGE', `Duplicate edge id "${edge.id}"`, at);
    seenEdges.add(edge.id);
    const source = index.nodes.get(edge.source);
    const target = index.nodes.get(edge.target);
    if (!source || !target) {
      issues.error('E_EDGE', `Edge "${edge.id}" connects a node that does not exist`, at);
      continue;
    }
    if (edge.source === edge.target) {
      issues.error('E_EDGE', `${nameOf(source)} is connected to itself`, { ...at, nodeId: source.id });
      continue;
    }
    const connection = `${edge.source}:${edge.sourceHandle ?? 'out'}->${edge.target}:${edge.kind ?? 'normal'}`;
    if (connections.has(connection)) issues.error('E_EDGE', `${nameOf(source)} → ${nameOf(target)} is connected twice`, at);
    connections.add(connection);
    if (!catalogEntry(target.type).handles.input) issues.error('E_EDGE', `${nameOf(target)} cannot have incoming connections`, at);
    const handle = edge.sourceHandle ?? 'out';
    if (handle !== 'out' && source.type !== 'quality-gate') {
      issues.error('E_HANDLE', `Only quality gates have pass/fail outputs (${nameOf(source)})`, { ...at, nodeId: source.id });
    } else if (!catalogEntry(source.type).handles.outputs.includes(handle)) {
      issues.error('E_EDGE', `${nameOf(source)} has no "${handle}" output; use pass or fail`, { ...at, nodeId: source.id });
    }
  }
}

function checkTrigger(graph: WorkflowGraph, index: GraphIndex, issues: Issues): void {
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) {
    issues.error('E_TRIGGER', `A workflow needs exactly one Start node (found ${triggers.length})`, { nodeId: triggers[1]?.id });
    return;
  }
  const reached = descendantsOf(index, [triggers[0].id]);
  reached.add(triggers[0].id);
  for (const id of index.ids) {
    if (!reached.has(id)) issues.error('E_UNREACHABLE', `${nameOf(index.nodes.get(id)!)} is not connected to the Start node`, { nodeId: id });
  }
}

function checkNodes(graph: WorkflowGraph, issues: Issues): void {
  for (const node of graph.nodes) {
    const entry = catalogEntry(node.type);
    const at = { nodeId: node.id };
    if (!entry.executable) issues.error('E_PLANNED', `${entry.label} is planned, not available yet: ${entry.plannedReason}`, at);
    if (node.type === 'trigger' && (node.config.mode === 'schedule' || node.config.mode === 'webhook')) {
      issues.error('E_PLANNED', 'Schedule and webhook triggers need a scheduler service; not in V2.0', at);
    }
    for (const field of entry.fields) {
      const problem = checkFieldValue(field, node.config[field.key]);
      if (problem) issues.error(problem.code, `${nameOf(node)}: ${problem.message}`, at);
    }
    const values = readNodeConfig(node);
    if (node.type === 'tool' && !configText(values, 'command')) issues.error('E_CONFIG', `${nameOf(node)}: a command is required`, at);
    if (node.type === 'requirement' && values.source === 'override' && !configText(values, 'specOverride')) {
      issues.error('E_CONFIG', `${nameOf(node)}: the specification override is empty`, at);
    }
    if (TASK_NODE_TYPES.has(node.type) && FIX_TASK_KEY.test(node.id)) {
      issues.error('E_CONFIG', `Node id "${node.id}" is reserved for runtime fix tasks (fix-<key>-<round>)`, at);
    }
  }
}

function checkCycles(index: GraphIndex, issues: Issues): void {
  const { cyclic } = topologicalOrder(index);
  if (cyclic.length) {
    issues.error('E_CYCLE', `These nodes form a loop (only Fix → verification retry links may go back): ${cyclic.join(', ')}`,
      { nodeId: cyclic[0] });
  }
}

function checkFixLoops(graph: WorkflowGraph, index: GraphIndex, issues: Issues): void {
  const node = (id: string): WorkflowNode | undefined => index.nodes.get(id);
  for (const edge of graph.edges) {
    const source = node(edge.source);
    const target = node(edge.target);
    if (!source || !target) continue;
    if (edge.kind === 'retry' && (source.type !== 'fix' || !VERIFICATION_TYPES.has(target.type))) {
      issues.error('E_FIX_TARGET', 'Retry links must go from a Fix node back to a QA, Security or Review node', { edgeId: edge.id });
    }
    if (edge.sourceHandle === 'fail' && target.type !== 'fix') {
      issues.error('E_FIX_TARGET', `A quality gate's fail output must lead to a Fix node (${nameOf(target)})`, { edgeId: edge.id });
    }
  }
  for (const gate of graph.nodes.filter((n) => n.type === 'quality-gate')) {
    const incoming = index.normalIn.get(gate.id) ?? [];
    if (incoming.length !== 1 || !VERIFICATION_TYPES.has(node(incoming[0].source)!.type)) {
      issues.error('E_CONFIG', `${nameOf(gate)} must follow exactly one QA, Security or Review node`, { nodeId: gate.id });
    }
  }
  for (const fix of graph.nodes.filter((n) => n.type === 'fix')) checkFixNode(graph, index, fix, issues);
}

/** fix: in = one gate 'fail' edge; out = one retry edge to the same verification node the gate follows. */
function checkFixNode(graph: WorkflowGraph, index: GraphIndex, fix: WorkflowNode, issues: Issues): void {
  const out = graph.edges.filter((e) => e.source === fix.id && index.nodes.has(e.target));
  const incoming = index.normalIn.get(fix.id) ?? [];
  const target = out.length === 1 && out[0].kind === 'retry' ? index.nodes.get(out[0].target)! : null;
  const gateEdge = incoming.length === 1 && incoming[0].sourceHandle === 'fail' ? incoming[0] : null;
  const gate = gateEdge ? index.nodes.get(gateEdge.source)! : null;
  const verified = gate?.type === 'quality-gate' ? (index.normalIn.get(gate.id) ?? []).map((e) => e.source) : [];
  if (!target || !VERIFICATION_TYPES.has(target.type) || !gate || verified.length !== 1 || verified[0] !== target.id) {
    issues.error('E_FIX_TARGET',
      `${nameOf(fix)} must come from a quality gate's fail output and link back (retry) to the node that gate checks`,
      { nodeId: fix.id });
  }
}

function checkSlots(graph: WorkflowGraph, index: GraphIndex, issues: Issues): void {
  const decomposes = graph.nodes.filter((n) => n.type === 'decompose');
  if (!decomposes.length) return;
  for (const extra of decomposes.slice(1)) {
    issues.error('E_SLOT', 'Only one Task decomposition node is allowed per workflow', { nodeId: extra.id });
  }
  const layout = slotLayout(index);
  if (!layout.slotIds.length) {
    issues.error('E_SLOT', 'Task decomposition needs at least one Backend or Frontend slot after it', { nodeId: layout.decomposeId! });
  }
  const classify = (n: WorkflowNode): NodeClass => classifyNode(n, layout);
  let entry: string | null = null;
  for (const id of layout.slotIds) {
    const slot = index.nodes.get(id)!;
    if (!ancestorsOf(index, id).has(layout.decomposeId!)) {
      issues.error('E_SLOT', `${nameOf(slot)} is an implementation slot but has no Task decomposition before it`, { nodeId: id });
      continue;
    }
    const deps = taskDependencies(index, id, classify);
    entry ??= deps.length === 1 ? deps[0] : null;
    if (deps.length !== 1 || deps[0] === SLOT_DEPENDENCY || deps[0] !== entry) {
      issues.error('E_SLOT', `All implementation slots must follow the same single step (${nameOf(slot)})`, { nodeId: id });
    }
  }
  const reserved = index.nodes.get('qa-verify');
  if (reserved && layout.qaVerifyId !== 'qa-verify') {
    issues.error('E_SLOT', 'Node id "qa-verify" is reserved for the QA step right after the implementation slots', { nodeId: reserved.id });
  }
}

function checkProviders(graph: WorkflowGraph, ctx: ValidationContext, issues: Issues): void {
  if (!ctx.providers) return;
  for (const node of graph.nodes) {
    const entry = catalogEntry(node.type);
    if (entry.category !== 'agent' || !entry.role || !entry.executable) continue;
    const role = entry.role;
    const known = ctx.providers.filter((p) => p.role === role);
    if (!known.length) {
      issues.warning('E_PROVIDER', `${nameOf(node)}: provider availability for the ${role} role is unknown`, { nodeId: node.id });
    } else if (!known.some((p) => p.available)) {
      issues.error('E_PROVIDER', `${nameOf(node)}: no enabled and available provider for the ${role} role`, { nodeId: node.id });
    }
  }
}

function checkCommands(graph: WorkflowGraph, ctx: ValidationContext, issues: Issues): void {
  const allowed = ctx.isCommandAllowed;
  if (!allowed) return;
  for (const node of graph.nodes) {
    if (node.type !== 'tool' && node.type !== 'qa') continue;
    const command = configText(readNodeConfig(node), node.type === 'tool' ? 'command' : 'testCommand');
    if (command && !allowed(command)) {
      issues.warning('E_COMMAND', `${nameOf(node)}: "${command}" is not in the allowlist; the run will ask for your approval`,
        { nodeId: node.id });
    }
  }
}

/** Validates a workflow graph (any JSON input). Errors block a run; warnings do not. */
export function validateWorkflow(input: unknown, ctx: ValidationContext = {}): ValidationResult {
  const issues = new Issues();
  const graph = parseGraph(input, issues);
  if (graph) {
    const index = indexGraph(graph);
    checkEdges(graph, index, issues);
    checkTrigger(graph, index, issues);
    checkNodes(graph, issues);
    checkCycles(index, issues);
    checkFixLoops(graph, index, issues);
    checkSlots(graph, index, issues);
    checkProviders(graph, ctx, issues);
    checkCommands(graph, ctx, issues);
  }
  const errors = issues.list.filter((i) => i.severity === 'error');
  const warnings = issues.list.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}
