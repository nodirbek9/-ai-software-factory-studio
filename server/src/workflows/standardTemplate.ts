import { STANDARD_WORKFLOW_ID, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '@asf/shared';

// The built-in "Standard Software Factory" template (WORKFLOW_ENGINE_SPEC.md §6.5). It compiles to exactly the V1
// pipeline (golden test), so node ids that produce tasks are the V1 task keys. Read-only; "Duplicate" makes a copy.

export const STANDARD_WORKFLOW_NAME = 'Standard Software Factory';
export const STANDARD_WORKFLOW_DESCRIPTION =
  'PM plan → architecture → your approval → Backend/Frontend tasks → QA → security review → final review → delivery report, '
  + 'with automatic fix rounds when tests or reviews fail.';

const X = 230;
const node = (id: string, type: WorkflowNode['type'], column: number, row: number, label?: string): WorkflowNode => ({
  id, type, label, position: { x: column * X, y: row * 130 }, config: {},
});

const nodes: WorkflowNode[] = [
  node('trigger', 'trigger', 0, 1, 'Start'),
  node('requirement', 'requirement', 1, 1, 'Project specification'),
  node('plan', 'decompose', 2, 1, 'Task plan (PM)'),
  node('architecture', 'architect', 3, 1, 'Architecture plan'),
  node('plan-approval', 'approval', 4, 1, 'Plan approval'),
  node('backend', 'backend', 5, 0, 'Backend tasks'),
  node('frontend', 'frontend', 5, 2, 'Frontend tasks'),
  node('qa-verify', 'qa', 6, 1, 'QA verification'),
  node('qa-gate', 'quality-gate', 7, 1, 'Tests gate'),
  node('qa-fix', 'fix', 7, 2, 'Fix failing tests'),
  node('security-review', 'security', 8, 1, 'Security review'),
  node('security-gate', 'quality-gate', 9, 1, 'Security gate'),
  node('security-fix', 'fix', 9, 2, 'Fix security findings'),
  node('final-review', 'reviewer', 10, 1, 'Final code review'),
  node('review-gate', 'quality-gate', 11, 1, 'Review gate'),
  node('review-fix', 'fix', 11, 2, 'Fix review findings'),
  node('delivery-report', 'artifact', 12, 1, 'Delivery report'),
];
nodes.find((n) => n.id === 'plan')!.config = { requireQa: true };

const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id: `${source}->${target}${extra.sourceHandle ? `:${extra.sourceHandle}` : ''}`, source, target, ...extra,
});

const edges: WorkflowEdge[] = [
  edge('trigger', 'requirement'),
  edge('requirement', 'plan'),
  edge('plan', 'architecture'),
  edge('architecture', 'plan-approval'),
  edge('plan-approval', 'backend'),
  edge('plan-approval', 'frontend'),
  edge('backend', 'qa-verify'),
  edge('frontend', 'qa-verify'),
  edge('qa-verify', 'qa-gate'),
  edge('qa-gate', 'security-review', { sourceHandle: 'pass' }),
  edge('qa-gate', 'qa-fix', { sourceHandle: 'fail' }),
  edge('qa-fix', 'qa-verify', { kind: 'retry' }),
  edge('security-review', 'security-gate'),
  edge('security-gate', 'final-review', { sourceHandle: 'pass' }),
  edge('security-gate', 'security-fix', { sourceHandle: 'fail' }),
  edge('security-fix', 'security-review', { kind: 'retry' }),
  edge('final-review', 'review-gate'),
  edge('review-gate', 'delivery-report', { sourceHandle: 'pass' }),
  edge('review-gate', 'review-fix', { sourceHandle: 'fail' }),
  edge('review-fix', 'final-review', { kind: 'retry' }),
];

export const STANDARD_WORKFLOW_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes, edges };

export const STANDARD_WORKFLOW = {
  id: STANDARD_WORKFLOW_ID,
  name: STANDARD_WORKFLOW_NAME,
  description: STANDARD_WORKFLOW_DESCRIPTION,
  graph: STANDARD_WORKFLOW_GRAPH,
} as const;
