import type { CompiledSkeleton, CompiledTask, TaskNodeOptions } from '@asf/shared';
import { SLOT_DEPENDENCY } from '@asf/shared';
import { AgentOutputError, type PlanOutput } from '../agents/parsers.ts';
import { validateGraph } from '../domain/taskGraph.ts';

// Dynamic expansion (WORKFLOW_ENGINE_SPEC.md §6.3): the PM's plan plus the compiled skeleton become task rows. For the
// Standard skeleton the rows equal V1's taskRunners.expandPlan (golden test WF-01).

export const QA_VERIFY_KEY = 'qa-verify';

/** Keys V1 always reserved for its fixed pipeline. */
const V1_RESERVED = ['plan', 'architecture', 'plan-approval', 'security-review', 'final-review', 'delivery-report', QA_VERIFY_KEY];

export interface ExpandArgs {
  /** Setting defaultMaxAttempts. */
  maxAttempts: number;
  /** orderIndex of the first new row (V1: the run's max orderIndex + 1). */
  startOrder: number;
  /** The project's test command (qa-verify description). */
  testCommand: string;
  /** Keys already in the run (start tasks); the plan must not reuse them. */
  existingKeys?: string[];
  /** Workflow node of the qa-verify rule (compile.ts qaVerifyNodeId); null/absent = none. */
  qaNodeId?: string | null;
}

function placement(role: PlanOutput['tasks'][number]['role'], skeleton: CompiledSkeleton, args: ExpandArgs): { nodeId: string | null; options: TaskNodeOptions } {
  if (role === 'qa') return { nodeId: args.qaNodeId ?? null, options: { ...(skeleton.qaOptions ?? {}) } };
  const slot = skeleton.slots.find((s) => s.role === role);
  return { nodeId: slot?.nodeId ?? null, options: { ...(slot?.options ?? {}) } };
}

/** Replaces SLOT_DEPENDENCY with the leaf keys of the PM tasks (or qa-verify), keeping any other dependency. */
function resolveSlots(dependsOn: string[], leaves: string[]): string[] {
  return [...new Set(dependsOn.flatMap((key) => (key === SLOT_DEPENDENCY ? leaves : [key])))];
}

/** Task rows for the PM's plan, V1's qa-verify rule and the skeleton tail. Throws AgentOutputError like V1. */
export function expandPlanRows(plan: PlanOutput, skeleton: CompiledSkeleton, args: ExpandArgs): CompiledTask[] {
  const reserved = new Set([
    ...V1_RESERVED, ...(args.existingKeys ?? []), ...skeleton.tail.map((t) => t.key),
    ...[skeleton.decomposeKey, skeleton.entryKey].filter((k): k is string => !!k),
  ]);
  const clash = plan.tasks.find((t) => reserved.has(t.key));
  if (clash) throw new AgentOutputError(`Plan uses a reserved task key: ${clash.key}`);
  const graphError = validateGraph(plan.tasks);
  if (graphError) throw new AgentOutputError(`Invalid task graph: ${graphError}`);

  const entry = skeleton.entryKey ?? skeleton.decomposeKey;
  const dependedOn = new Set(plan.tasks.flatMap((t) => t.dependsOn));
  let leaves = plan.tasks.filter((t) => !dependedOn.has(t.key)).map((t) => t.key);
  let order = args.startOrder;
  const rows = plan.tasks.map((t): CompiledTask => ({
    key: t.key, title: t.title, description: t.description, role: t.role,
    kind: t.role === 'qa' ? 'test' : 'implement',
    dependsOn: t.dependsOn.length ? [...t.dependsOn] : entry ? [entry] : [],
    orderIndex: order++, maxAttempts: args.maxAttempts, ...placement(t.role, skeleton, args),
  }));
  if (skeleton.requireQa && !plan.tasks.some((t) => t.role === 'qa')) {
    rows.push({
      key: QA_VERIFY_KEY, title: 'Verify with automated tests', role: 'qa', kind: 'test',
      description: `Add tests covering the specification and run \`${skeleton.qaOptions?.command ?? args.testCommand}\`.`,
      dependsOn: leaves, orderIndex: order++, maxAttempts: args.maxAttempts,
      nodeId: args.qaNodeId ?? null, options: { ...(skeleton.qaOptions ?? {}) },
    });
    leaves = [QA_VERIFY_KEY];
  }
  for (const t of skeleton.tail) {
    rows.push({ ...t, dependsOn: resolveSlots(t.dependsOn, leaves), orderIndex: order++, options: { ...t.options } });
  }
  return rows;
}
