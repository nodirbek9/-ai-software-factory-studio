import { describe, expect, test } from 'vitest';
import {
  AGENT_ROLES, SLOT_DEPENDENCY, WORKFLOW_NODE_TYPES, type CompiledTask, type WorkflowEdge, type WorkflowGraph,
  type WorkflowIssueCode, type WorkflowNode,
} from '@asf/shared';
import type { PlanOutput } from '../src/agents/parsers.ts';
import { NODE_CATALOG, catalogEntry, nodeOptionsFromConfig } from '../src/workflows/catalog.ts';
import { WorkflowCompileError, compileWorkflow, qaVerifyNodeId } from '../src/workflows/compile.ts';
import { expandPlanRows } from '../src/workflows/expand.ts';
import { STANDARD_WORKFLOW_GRAPH } from '../src/workflows/standardTemplate.ts';
import { validateWorkflow, type ValidationContext } from '../src/workflows/validate.ts';

const CTX = { maxAttempts: 3, testCommand: 'npm test' };

const standard = (): WorkflowGraph => structuredClone(STANDARD_WORKFLOW_GRAPH);
const node = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, config });
const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `${source}->${target}${extra.sourceHandle ? `:${extra.sourceHandle}` : ''}`, source, target, ...extra });

/** The V1 columns of a task row (what projectService/taskRunners write). */
const v1 = (t: CompiledTask) => ({
  key: t.key, title: t.title, description: t.description, role: t.role, kind: t.kind, dependsOn: t.dependsOn,
  orderIndex: t.orderIndex, maxAttempts: t.maxAttempts,
});

function issueCodes(graph: unknown, ctx?: ValidationContext): { errors: WorkflowIssueCode[]; warnings: WorkflowIssueCode[] } {
  const result = validateWorkflow(graph, ctx);
  return { errors: result.errors.map((i) => i.code), warnings: result.warnings.map((i) => i.code) };
}

/** trigger → requirement → architect → (backend, frontend) → qa → gate(pass → reviewer → notify, fail → fix ↺ qa). */
function fanGraph(): WorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      node('trigger', 'trigger'), node('requirement', 'requirement'), node('arch', 'architect'),
      node('api', 'backend', { title: 'Build API', description: 'REST endpoints' }), node('web', 'frontend'),
      node('tests', 'qa'), node('tests-gate', 'quality-gate', { maxRounds: 1 }), node('tests-fix', 'fix', { role: 'backend' }),
      node('review', 'reviewer'), node('ping', 'notify', { message: 'done {{status}}' }),
    ],
    edges: [
      edge('trigger', 'requirement'), edge('requirement', 'arch'), edge('arch', 'api'), edge('arch', 'web'),
      edge('api', 'tests'), edge('web', 'tests'), edge('tests', 'tests-gate'),
      edge('tests-gate', 'review', { sourceHandle: 'pass' }), edge('tests-gate', 'tests-fix', { sourceHandle: 'fail' }),
      edge('tests-fix', 'tests', { kind: 'retry' }), edge('review', 'ping'),
    ],
  };
}

// Fixed PM plans: one without a QA task (V1 adds qa-verify), one with a QA task.
const PLAN_NO_QA: PlanOutput = { tasks: [
  { key: 'api', title: 'Build the API', description: 'REST endpoints', role: 'backend', dependsOn: [] },
  { key: 'ui', title: 'Build the UI', description: 'React screens', role: 'frontend', dependsOn: ['api'] },
  { key: 'docs', title: 'Write docs', description: '', role: 'backend', dependsOn: [] },
] };
const PLAN_WITH_QA: PlanOutput = { tasks: [
  { key: 'backend-core', title: 'Core services', description: 'Services', role: 'backend', dependsOn: [] },
  { key: 'frontend-shell', title: 'App shell', description: 'Layout', role: 'frontend', dependsOn: [] },
  { key: 'e2e-tests', title: 'End-to-end tests', description: 'Cover flows', role: 'qa', dependsOn: ['backend-core', 'frontend-shell'] },
] };

const V1_TAIL = [
  { key: 'security-review', title: 'Security review of integrated change', role: 'security', kind: 'security', description: 'Review the full diff for vulnerabilities.' },
  { key: 'final-review', title: 'Final code review', role: 'reviewer', kind: 'review', description: 'Review correctness, quality and spec adherence.' },
  { key: 'delivery-report', title: 'Delivery report', role: 'pm', kind: 'report', description: 'Generate the final implementation report.' },
];

describe('WF-01 Standard template golden test', () => {
  test('the Standard template is valid without warnings', () => {
    expect(validateWorkflow(STANDARD_WORKFLOW_GRAPH)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test('start tasks equal V1 startPlanning rows', () => {
    const compiled = compileWorkflow(STANDARD_WORKFLOW_GRAPH, CTX);
    expect(compiled.tasks.map(v1)).toEqual([
      { key: 'plan', title: 'Create task plan from specification', description: 'Break the specification into dependency-aware tasks.',
        role: 'pm', kind: 'plan', dependsOn: [], orderIndex: 1, maxAttempts: 3 },
      { key: 'architecture', title: 'Technical architecture plan', description: 'Write the implementation plan for the planned tasks.',
        role: 'architect', kind: 'architecture', dependsOn: ['plan'], orderIndex: 2, maxAttempts: 3 },
      { key: 'plan-approval', title: 'Plan approval', description: 'The user reviews and approves the plan before any code is written.',
        role: 'pm', kind: 'gate', dependsOn: ['architecture'], orderIndex: 3, maxAttempts: 1 },
    ]);
    expect(compiled.tasks.map((t) => t.nodeId)).toEqual(['plan', 'architecture', 'plan-approval']);
    expect(compiled.skeleton).toMatchObject({
      decomposeKey: 'plan', entryKey: 'plan-approval', requireQa: true, qaOptions: {},
      slots: [{ nodeId: 'backend', role: 'backend', options: {} }, { nodeId: 'frontend', role: 'frontend', options: {} }],
    });
    expect(compiled.skeleton.tail.map((t) => [t.key, t.dependsOn])).toEqual([
      ['security-review', [SLOT_DEPENDENCY]], ['final-review', ['security-review']], ['delivery-report', ['final-review']],
    ]);
    expect(qaVerifyNodeId(STANDARD_WORKFLOW_GRAPH)).toBe('qa-verify');
  });

  test('expansion of a plan without QA equals V1 expandPlan rows', () => {
    const { skeleton } = compileWorkflow(STANDARD_WORKFLOW_GRAPH, CTX);
    const rows = expandPlanRows(PLAN_NO_QA, skeleton, { ...CTX, startOrder: 4, qaNodeId: 'qa-verify' });
    expect(rows.map(v1)).toEqual([
      { key: 'api', title: 'Build the API', description: 'REST endpoints', role: 'backend', kind: 'implement', dependsOn: ['plan-approval'], orderIndex: 4, maxAttempts: 3 },
      { key: 'ui', title: 'Build the UI', description: 'React screens', role: 'frontend', kind: 'implement', dependsOn: ['api'], orderIndex: 5, maxAttempts: 3 },
      { key: 'docs', title: 'Write docs', description: '', role: 'backend', kind: 'implement', dependsOn: ['plan-approval'], orderIndex: 6, maxAttempts: 3 },
      { key: 'qa-verify', title: 'Verify with automated tests', description: 'Add tests covering the specification and run `npm test`.',
        role: 'qa', kind: 'test', dependsOn: ['ui', 'docs'], orderIndex: 7, maxAttempts: 3 },
      { ...V1_TAIL[0], dependsOn: ['qa-verify'], orderIndex: 8, maxAttempts: 3 },
      { ...V1_TAIL[1], dependsOn: ['security-review'], orderIndex: 9, maxAttempts: 3 },
      { ...V1_TAIL[2], dependsOn: ['final-review'], orderIndex: 10, maxAttempts: 3 },
    ]);
    expect(rows.map((t) => t.nodeId)).toEqual(['backend', 'frontend', 'backend', 'qa-verify', 'security-review', 'final-review', 'delivery-report']);
  });

  test('expansion of a plan with a QA task equals V1 expandPlan rows', () => {
    const { skeleton } = compileWorkflow(STANDARD_WORKFLOW_GRAPH, CTX);
    const rows = expandPlanRows(PLAN_WITH_QA, skeleton, { ...CTX, startOrder: 4 });
    expect(rows.map(v1)).toEqual([
      { key: 'backend-core', title: 'Core services', description: 'Services', role: 'backend', kind: 'implement', dependsOn: ['plan-approval'], orderIndex: 4, maxAttempts: 3 },
      { key: 'frontend-shell', title: 'App shell', description: 'Layout', role: 'frontend', kind: 'implement', dependsOn: ['plan-approval'], orderIndex: 5, maxAttempts: 3 },
      { key: 'e2e-tests', title: 'End-to-end tests', description: 'Cover flows', role: 'qa', kind: 'test', dependsOn: ['backend-core', 'frontend-shell'], orderIndex: 6, maxAttempts: 3 },
      { ...V1_TAIL[0], dependsOn: ['e2e-tests'], orderIndex: 7, maxAttempts: 3 },
      { ...V1_TAIL[1], dependsOn: ['security-review'], orderIndex: 8, maxAttempts: 3 },
      { ...V1_TAIL[2], dependsOn: ['final-review'], orderIndex: 9, maxAttempts: 3 },
    ]);
  });

  test('plan keys that clash with reserved keys are rejected like V1', () => {
    const { skeleton } = compileWorkflow(STANDARD_WORKFLOW_GRAPH, CTX);
    const plan: PlanOutput = { tasks: [{ key: 'architecture', title: 'x', description: '', role: 'backend', dependsOn: [] }] };
    expect(() => expandPlanRows(plan, skeleton, { ...CTX, startOrder: 4 })).toThrow('Plan uses a reserved task key: architecture');
    const cyclic: PlanOutput = { tasks: [
      { key: 'a', title: 'a', description: '', role: 'backend', dependsOn: ['b'] },
      { key: 'b', title: 'b', description: '', role: 'backend', dependsOn: ['a'] },
    ] };
    expect(() => expandPlanRows(cyclic, skeleton, { ...CTX, startOrder: 4 })).toThrow('Invalid task graph: dependency cycle');
  });

  test('slot and QA node options reach the expanded rows', () => {
    const graph = standard();
    graph.nodes.find((n) => n.id === 'backend')!.config = { model: 'big-model', timeoutMinutes: 60 };
    graph.nodes.find((n) => n.id === 'qa-verify')!.config = { testCommand: 'npx vitest run' };
    const { skeleton } = compileWorkflow(graph, CTX);
    const rows = expandPlanRows(PLAN_NO_QA, skeleton, { ...CTX, startOrder: 4, qaNodeId: 'qa-verify' });
    expect(rows[0].options).toEqual({ model: 'big-model', timeoutMinutes: 60 });
    expect(rows[1].options).toEqual({});
    expect(rows[3]).toMatchObject({ key: 'qa-verify', options: { command: 'npx vitest run' },
      description: 'Add tests covering the specification and run `npx vitest run`.' });
  });
});

describe('quality gates, retry and fan-out/fan-in', () => {
  test('a custom fan-out/fan-in graph without decomposition compiles with the right dependencies', () => {
    const compiled = compileWorkflow(fanGraph(), CTX);
    expect(compiled.tasks.map((t) => [t.key, t.kind, t.role, t.dependsOn, t.orderIndex])).toEqual([
      ['arch', 'architecture', 'architect', [], 1],
      ['api', 'implement', 'backend', ['arch'], 2],
      ['web', 'implement', 'frontend', ['arch'], 3],
      ['tests', 'test', 'qa', ['api', 'web'], 4],
      ['review', 'review', 'reviewer', ['tests'], 5],
      ['ping', 'notify', 'pm', ['review'], 6],
    ]);
    expect(compiled.tasks[1]).toMatchObject({ title: 'Build API', description: 'REST endpoints', nodeId: 'api' });
    expect(compiled.tasks[5].options).toEqual({ message: 'done {{status}}' });
    expect(compiled.skeleton).toEqual({ decomposeKey: null, entryKey: null, slots: [], tail: [], requireQa: false, qaOptions: null });
  });

  test('quality gate maxRounds and fix role land on the verification task', () => {
    const tests = compileWorkflow(fanGraph(), CTX).tasks.find((t) => t.key === 'tests')!;
    expect(tests.options).toEqual({ fixRoundsMax: 1, fixRole: 'backend' });

    const graph = standard();
    graph.nodes.find((n) => n.id === 'qa-gate')!.config = { maxRounds: 0 };
    graph.nodes.find((n) => n.id === 'qa-fix')!.config = { role: 'frontend' };
    graph.nodes.find((n) => n.id === 'security-gate')!.config = { maxRounds: 2 };
    const { skeleton } = compileWorkflow(graph, CTX);
    expect(skeleton.qaOptions).toEqual({ fixRoundsMax: 0, fixRole: 'frontend' });
    expect(skeleton.tail.find((t) => t.key === 'security-review')!.options).toEqual({ fixRoundsMax: 2 });
    expect(skeleton.tail.find((t) => t.key === 'final-review')!.options).toEqual({});
  });

  test('a retry node sets the attempts of the task before it', () => {
    const graph = fanGraph();
    graph.nodes.push(node('again', 'retry', { maxAttempts: 5 }));
    graph.edges = graph.edges.filter((e) => e.id !== 'arch->api');
    graph.edges.push(edge('arch', 'again'), edge('again', 'api'));
    const tasks = compileWorkflow(graph, CTX).tasks;
    expect(tasks.find((t) => t.key === 'arch')!.maxAttempts).toBe(5);
    expect(tasks.find((t) => t.key === 'api')!.dependsOn).toEqual(['arch']);
  });
});

describe('WF-02 validator: every error code', () => {
  test('E_TRIGGER: no Start node, or two', () => {
    const none = standard();
    none.nodes = none.nodes.filter((n) => n.type !== 'trigger');
    none.edges = none.edges.filter((e) => e.source !== 'trigger');
    expect(issueCodes(none).errors).toContain('E_TRIGGER');
    const two = standard();
    two.nodes.push(node('trigger-2', 'trigger'));
    expect(issueCodes(two).errors).toContain('E_TRIGGER');
  });

  test('E_UNREACHABLE: a node not connected to the Start node', () => {
    const graph = standard();
    graph.nodes.push(node('orphan', 'notify'));
    expect(validateWorkflow(graph).errors).toEqual([expect.objectContaining({ code: 'E_UNREACHABLE', nodeId: 'orphan' })]);
  });

  test('E_CYCLE: a loop made of normal edges', () => {
    const graph = fanGraph();
    graph.edges.push(edge('review', 'arch'));
    expect(issueCodes(graph).errors).toContain('E_CYCLE');
  });

  test('E_HANDLE: pass/fail outputs on a node that is not a quality gate', () => {
    const graph = fanGraph();
    graph.edges.find((e) => e.id === 'arch->api')!.sourceHandle = 'pass';
    expect(issueCodes(graph).errors).toContain('E_HANDLE');
  });

  test('E_FIX_TARGET: a fix node that does not lead back to its verification node', () => {
    const graph = standard();
    graph.edges.find((e) => e.source === 'qa-fix')!.target = 'architecture';
    expect(issueCodes(graph).errors).toContain('E_FIX_TARGET');
    const failToTask = fanGraph();
    failToTask.edges.find((e) => e.sourceHandle === 'fail')!.target = 'ping';
    expect(issueCodes(failToTask).errors).toContain('E_FIX_TARGET');
  });

  test('E_SLOT: a backend slot without Task decomposition before it', () => {
    const graph = standard();
    graph.nodes.push(node('hotfix', 'backend'));
    graph.edges.push(edge('trigger', 'hotfix'));
    expect(validateWorkflow(graph).errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E_SLOT', nodeId: 'hotfix' })]));
  });

  test('E_PROVIDER: error when a role has no available provider, warning when unknown', () => {
    const providers = AGENT_ROLES.map((role) => ({ role, available: role !== 'qa' }));
    const result = validateWorkflow(STANDARD_WORKFLOW_GRAPH, { providers });
    expect(result.errors).toEqual([expect.objectContaining({ code: 'E_PROVIDER', nodeId: 'qa-verify' })]);
    const unknown = issueCodes(STANDARD_WORKFLOW_GRAPH, { providers: providers.filter((p) => p.role !== 'security') });
    expect(unknown.warnings).toEqual(['E_PROVIDER']);
    expect(unknown.errors).toEqual(['E_PROVIDER']);
  });

  test('E_COMMAND: a command outside the allowlist is a warning only', () => {
    const graph = fanGraph();
    graph.nodes.push(node('lint', 'tool', { command: 'make lint' }));
    graph.edges.push(edge('review', 'lint'));
    const result = validateWorkflow(graph, { isCommandAllowed: (c) => c === 'npm test' });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'E_COMMAND', nodeId: 'lint' })]);
    expect(compileWorkflow(graph, CTX).tasks.find((t) => t.key === 'lint')).toMatchObject({ kind: 'command', role: 'qa', options: { command: 'make lint' } });
  });

  test('E_LIMIT: too many nodes and a label that is too long', () => {
    const big = fanGraph();
    for (let i = 0; i < 60; i++) big.nodes.push(node(`n-${i}`, 'notify'));
    expect(issueCodes(big).errors).toContain('E_LIMIT');
    const label = fanGraph();
    label.nodes[2].label = 'x'.repeat(81);
    expect(issueCodes(label).errors).toEqual(['E_LIMIT']);
  });

  test('E_CONFIG: out-of-range value, missing command, bad node id', () => {
    const range = fanGraph();
    range.nodes.find((n) => n.id === 'arch')!.config = { timeoutMinutes: 1000 };
    expect(issueCodes(range).errors).toEqual(['E_CONFIG']);
    const tool = fanGraph();
    tool.nodes.push(node('cmd', 'tool'));
    tool.edges.push(edge('review', 'cmd'));
    expect(issueCodes(tool).errors).toEqual(['E_CONFIG']);
    const id = fanGraph();
    id.nodes[2].id = 'Bad_Id';
    expect(issueCodes(id).errors).toContain('E_CONFIG');
  });

  test('E_EDGE: missing node, self loop, duplicate id, gate edge without pass/fail', () => {
    const missing = fanGraph();
    missing.edges.push(edge('review', 'nowhere'));
    expect(issueCodes(missing).errors).toContain('E_EDGE');
    const self = fanGraph();
    self.edges.push(edge('ping', 'ping'));
    expect(issueCodes(self).errors).toEqual(['E_EDGE']);
    const duplicate = fanGraph();
    duplicate.nodes.push(node('ping', 'notify'));
    expect(issueCodes(duplicate).errors).toContain('E_EDGE');
    const gate = fanGraph();
    delete gate.edges.find((e) => e.id === 'tests-gate->review:pass')!.sourceHandle;
    expect(issueCodes(gate).errors).toContain('E_EDGE');
  });
});

describe('WF-05 planned nodes', () => {
  test('a planned node is E_PLANNED and cannot compile', () => {
    const graph = standard();
    graph.nodes.push(node('wait', 'delay'));
    graph.edges.push(edge('trigger', 'wait'));
    const result = validateWorkflow(graph);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ code: 'E_PLANNED', nodeId: 'wait' })]);
    expect(result.errors[0].message).toContain('Timers that survive restarts are not built yet');
    let thrown: unknown = null;
    try {
      compileWorkflow(graph, CTX);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowCompileError);
    expect((thrown as WorkflowCompileError).issues.map((i) => i.code)).toEqual(['E_PLANNED']);
  });

  test('a scheduled trigger is planned', () => {
    const graph = standard();
    graph.nodes[0].config = { mode: 'schedule' };
    expect(issueCodes(graph).errors).toEqual(['E_PLANNED']);
  });
});

describe('node catalog', () => {
  test('covers every node type with handles and planned reasons', () => {
    expect(NODE_CATALOG.map((e) => e.type).sort()).toEqual([...WORKFLOW_NODE_TYPES].sort());
    expect(catalogEntry('trigger').handles).toEqual({ input: false, outputs: ['out'] });
    expect(catalogEntry('quality-gate').handles.outputs).toEqual(['pass', 'fail']);
    expect(catalogEntry('artifact').handles.outputs).toEqual(['out']);
    const planned = NODE_CATALOG.filter((e) => !e.executable);
    expect(planned.map((e) => e.type)).toEqual(['delay', 'deploy', 'condition', 'notify-external']);
    expect(planned.every((e) => !!e.plannedReason)).toBe(true);
  });

  test('nodeOptionsFromConfig keeps only valid, clamped values', () => {
    expect(nodeOptionsFromConfig(node('x', 'architect', { timeoutMinutes: 1000, effort: 'bogus', model: ' m ', maxAttempts: 9, onFailure: 'continue' })))
      .toEqual({ timeoutMinutes: 480, model: 'm', onFailure: 'continue' });
    expect(nodeOptionsFromConfig(node('g', 'quality-gate', { maxRounds: 7 }))).toEqual({ fixRoundsMax: 5 });
    expect(nodeOptionsFromConfig(node('d', 'decompose', { requireQa: false }))).toEqual({ requireQa: false });
  });
});
