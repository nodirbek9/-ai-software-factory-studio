import type {
  AgentRole, CompiledRun, CompiledSkeleton, CompiledTask, TaskKind, TaskNodeOptions, WorkflowGraph, WorkflowIssue, WorkflowNode,
  WorkflowNodeType,
} from '@asf/shared';
import { SLOT_DEPENDENCY } from '@asf/shared';
import { catalogEntry, configText, nodeMaxAttempts, nodeOptionsFromConfig, readNodeConfig } from './catalog.ts';
import {
  classifyNode, descendantsOf, indexGraph, slotLayout, taskDependencies, topologicalOrder, validateWorkflow, type GraphIndex,
  type NodeClass, type SlotLayout,
} from './validate.ts';

// Workflow compiler (WORKFLOW_ENGINE_SPEC.md §6.2-6.4): a validated graph becomes V1 task rows. With a decompose
// node, only the steps before the implementation slots are inserted at run start; the rest is the skeleton that
// expandPlanRows (expand.ts) places after the PM's tasks once the plan is known.

export interface CompileContext {
  /** Setting defaultMaxAttempts (used when a node sets none). */
  maxAttempts: number;
  /** The project's test command (QA task descriptions). */
  testCommand: string;
}

export class WorkflowCompileError extends Error {
  constructor(readonly issues: WorkflowIssue[]) {
    super(`Workflow is not valid: ${issues.map((i) => i.message).join('; ')}`);
  }
}

const TASK_SHAPE: Partial<Record<WorkflowNodeType, { kind: TaskKind; role: AgentRole }>> = {
  architect: { kind: 'architecture', role: 'architect' },
  decompose: { kind: 'plan', role: 'pm' },
  backend: { kind: 'implement', role: 'backend' },
  frontend: { kind: 'implement', role: 'frontend' },
  qa: { kind: 'test', role: 'qa' },
  security: { kind: 'security', role: 'security' },
  reviewer: { kind: 'review', role: 'reviewer' },
  approval: { kind: 'gate', role: 'pm' },
  tool: { kind: 'command', role: 'qa' },
  artifact: { kind: 'report', role: 'pm' },
  notify: { kind: 'notify', role: 'pm' },
};

/** V1 task texts (projectService.startPlanning, taskRunners.expandPlan), used when a node keeps its V1 key. */
const V1_TEXT: Record<string, { type: WorkflowNodeType; title: string; description: string }> = {
  plan: { type: 'decompose', title: 'Create task plan from specification', description: 'Break the specification into dependency-aware tasks.' },
  architecture: { type: 'architect', title: 'Technical architecture plan', description: 'Write the implementation plan for the planned tasks.' },
  'plan-approval': { type: 'approval', title: 'Plan approval', description: 'The user reviews and approves the plan before any code is written.' },
  'security-review': { type: 'security', title: 'Security review of integrated change', description: 'Review the full diff for vulnerabilities.' },
  'final-review': { type: 'reviewer', title: 'Final code review', description: 'Review correctness, quality and spec adherence.' },
  'delivery-report': { type: 'artifact', title: 'Delivery report', description: 'Generate the final implementation report.' },
};

const DESCRIPTION: Partial<Record<WorkflowNodeType, string>> = {
  architect: V1_TEXT.architecture.description,
  decompose: V1_TEXT.plan.description,
  approval: 'The user reviews and approves before the run continues.',
  security: V1_TEXT['security-review'].description,
  reviewer: V1_TEXT['final-review'].description,
  artifact: V1_TEXT['delivery-report'].description,
  notify: 'Show an in-app notification.',
};

function taskText(node: WorkflowNode, options: TaskNodeOptions, ctx: CompileContext): { title: string; description: string } {
  const values = readNodeConfig(node);
  const v1 = V1_TEXT[node.id]?.type === node.type ? V1_TEXT[node.id] : null;
  const title = configText(values, 'title') ?? v1?.title ?? (node.label?.trim() || catalogEntry(node.type).label);
  const fallback = node.type === 'qa' ? `Add tests covering the specification and run \`${options.command ?? ctx.testCommand}\`.`
    : node.type === 'tool' ? `Run \`${options.command ?? ''}\` in the integration worktree.`
      : node.type === 'backend' || node.type === 'frontend' ? `Implement the ${node.type} part of the specification.`
        : DESCRIPTION[node.type] ?? catalogEntry(node.type).description;
  const description = configText(values, 'description') ?? configText(values, 'instructions') ?? v1?.description ?? fallback;
  return { title, description };
}

function buildTask(node: WorkflowNode, index: GraphIndex, classify: (n: WorkflowNode) => NodeClass, ctx: CompileContext): CompiledTask {
  const shape = TASK_SHAPE[node.type]!;
  const options = nodeOptionsFromConfig(node);
  return {
    key: node.id,
    ...taskText(node, options, ctx),
    role: shape.role,
    kind: shape.kind,
    dependsOn: taskDependencies(index, node.id, classify),
    orderIndex: 0,
    maxAttempts: node.type === 'approval' ? 1 : nodeMaxAttempts(node) ?? ctx.maxAttempts,
    nodeId: node.id,
    options,
  };
}

const nodesOfType = (index: GraphIndex, type: WorkflowNodeType): WorkflowNode[] =>
  index.ids.map((id) => index.nodes.get(id)!).filter((n) => n.type === type);

/** quality-gate maxRounds → fixRoundsMax, its Fix node's role → fixRole, both on the verification task it follows. */
function applyQualityGates(index: GraphIndex, built: Map<string, CompiledTask>): void {
  for (const gate of nodesOfType(index, 'quality-gate')) {
    const task = built.get(index.normalIn.get(gate.id)![0]?.source ?? '');
    if (!task) continue;
    const rounds = nodeOptionsFromConfig(gate).fixRoundsMax;
    if (rounds !== undefined) task.options.fixRoundsMax = rounds;
    for (const edge of index.normalOut.get(gate.id)!.filter((e) => e.sourceHandle === 'fail')) {
      const fixRole = nodeOptionsFromConfig(index.nodes.get(edge.target)!).fixRole;
      if (fixRole && fixRole !== 'auto') task.options.fixRole = fixRole;
    }
  }
}

/** retry maxAttempts → the attempts of the nearest upstream task(s). */
function applyRetries(index: GraphIndex, layout: SlotLayout, built: Map<string, CompiledTask>, notes: string[]): void {
  const classify = (n: WorkflowNode): NodeClass => (n.id === layout.qaVerifyId ? 'task' : classifyNode(n, layout));
  for (const retry of nodesOfType(index, 'retry')) {
    const attempts = nodeMaxAttempts(retry);
    if (attempts === undefined) continue;
    for (const key of taskDependencies(index, retry.id, classify)) {
      const task = built.get(key);
      if (key === SLOT_DEPENDENCY || key === layout.qaVerifyId || !task) {
        notes.push(`Retry "${retry.id}": attempts of PM-planned tasks use the "Default max attempts" setting; ignored.`);
      } else if (task.kind === 'gate') {
        notes.push(`Retry "${retry.id}": approvals are decided once; ignored for "${key}".`);
      } else {
        task.maxAttempts = attempts;
      }
    }
  }
}

const numbered = (tasks: CompiledTask[], from: number): CompiledTask[] => tasks.map((t, i) => ({ ...t, orderIndex: from + i }));

const emptySkeleton = (): CompiledSkeleton => ({
  decomposeKey: null, entryKey: null, slots: [], tail: [], requireQa: false, qaOptions: null,
});

/** Start tasks = everything not downstream of the slots; tail = the rest (minus the qa-verify node). */
function splitAtSlots(index: GraphIndex, layout: SlotLayout, built: Map<string, CompiledTask>, notes: string[]): CompiledRun {
  const downstream = descendantsOf(index, layout.slotIds);
  const start: CompiledTask[] = [];
  const tail: CompiledTask[] = [];
  for (const task of built.values()) {
    if (task.key !== layout.qaVerifyId) (downstream.has(task.key) ? tail : start).push(task);
  }
  const decomposeId = layout.decomposeId!;
  const classify = (n: WorkflowNode): NodeClass => classifyNode(n, layout);
  const slots = layout.slotIds.map((id) => {
    const node = index.nodes.get(id)!;
    return { nodeId: id, role: node.type === 'frontend' ? 'frontend' as const : 'backend' as const, options: nodeOptionsFromConfig(node) };
  });
  for (const role of ['backend', 'frontend'] as const) {
    if (!slots.some((s) => s.role === role)) notes.push(`No ${role} slot: ${role} tasks the PM plans still run, with the role's agent settings.`);
  }
  const skeleton: CompiledSkeleton = {
    decomposeKey: decomposeId,
    entryKey: taskDependencies(index, layout.slotIds[0], classify)[0] ?? decomposeId,
    slots,
    tail: numbered(tail, start.length + 1),
    requireQa: nodeOptionsFromConfig(index.nodes.get(decomposeId)!).requireQa ?? true,
    qaOptions: layout.qaVerifyId ? built.get(layout.qaVerifyId)!.options : null,
  };
  return { tasks: numbered(start, 1), skeleton, notes };
}

/** Compiles a workflow graph to task rows; throws WorkflowCompileError when validation finds errors. */
export function compileWorkflow(graph: WorkflowGraph, ctx: CompileContext): CompiledRun {
  const validation = validateWorkflow(graph);
  if (!validation.ok) throw new WorkflowCompileError(validation.errors);
  const index = indexGraph(graph);
  const layout = slotLayout(index);
  const classify = (n: WorkflowNode): NodeClass => classifyNode(n, layout);
  const built = new Map<string, CompiledTask>();
  for (const id of topologicalOrder(index).order) {
    const node = index.nodes.get(id)!;
    if (classify(node) === 'task' || id === layout.qaVerifyId) built.set(id, buildTask(node, index, classify, ctx));
  }
  const notes: string[] = [];
  applyQualityGates(index, built);
  applyRetries(index, layout, built, notes);
  if (layout.decomposeId) return splitAtSlots(index, layout, built, notes);
  return { tasks: numbered([...built.values()], 1), skeleton: emptySkeleton(), notes };
}

/** Id of the qa node that becomes the `qa-verify` task (pass it to expandPlanRows as `qaNodeId`). */
export function qaVerifyNodeId(graph: WorkflowGraph): string | null {
  return slotLayout(indexGraph(graph)).qaVerifyId;
}
