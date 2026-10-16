import type { Task, WorkflowEdge, WorkflowGraph, WorkflowNode } from '@asf/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { Studio } from '../src/app.ts';
import { fixRoundsUsed } from '../src/orchestrator/fixLoop.ts';
import { prepareSamples, projectOf, startStudio, tempDir, waitFor } from './helpers.ts';

// Custom workflows end to end through RunService with the Scripted provider (WORKFLOW_ENGINE_SPEC.md §10 WF-03, WF-04).

let studios: Studio[] = [];

afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

const node = (id: string, type: WorkflowNode['type'], config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, type, position: { x: 0, y: 0 }, config });
const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `${source}->${target}`, source, target, ...extra });
const note = (key: string): Record<string, unknown> =>
  ({ delayMs: 100, summary: `Wrote ${key}.`, files: [{ path: `docs/${key}.md`, content: `${key}\n` }] });
const PASSING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n";
const BROKEN_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n";

async function runWorkflow(studio: Studio, name: string, graph: WorkflowGraph): Promise<{ projectId: string; runId: string }> {
  const project = await studio.projects.create({ name, spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
  const workflow = studio.ctx.repos.workflows.create({ name: `${name} workflow`, projectId: project.id, graph });
  const run = studio.runs.start(project.id, workflow.id);
  return { projectId: project.id, runId: run.id };
}

const tasksOf = (studio: Studio, runId: string): Map<string, Task> =>
  new Map(studio.ctx.repos.tasks.listByRun(runId).map((t) => [t.key, t]));
const finished = (studio: Studio, runId: string) =>
  waitFor(() => { const run = studio.ctx.repos.runs.get(runId)!; return run.finishedAt ? run : null; }, 120_000, 'run finished');

describe('custom workflow runs', () => {
  test('WF-03: fan-out / fan-in graph runs every branch and joins before QA', async () => {
    const samples = prepareSamples((script) => {
      for (const key of ['api', 'worker', 'ui']) script.tasks[key] = note(key);
      const qa = structuredClone(script.tasks['api-tests']) as { files: { path: string; content: string }[] };
      qa.files[0].content = PASSING_TEST;
      script.tasks.verify = qa;
    });
    const studio = await startStudio(tempDir('wf03'), samples);
    studios.push(studio);
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node('start', 'trigger'), node('api', 'backend', { title: 'API' }), node('worker', 'backend', { title: 'Worker' }),
        node('ui', 'frontend', { title: 'UI' }), node('verify', 'qa'), node('done', 'notify')],
      edges: [edge('start', 'api'), edge('api', 'worker'), edge('api', 'ui'), edge('worker', 'verify'), edge('ui', 'verify'),
        edge('verify', 'done')],
    };
    const { projectId, runId } = await runWorkflow(studio, 'Fan', graph);
    const run = await finished(studio, runId);
    const tasks = tasksOf(studio, runId);

    expect(run.status, JSON.stringify([...tasks.values()].map((t) => [t.key, t.status, t.error]))).toBe('completed');
    expect(projectOf(studio, projectId).status).toBe('completed');
    expect(tasks.get('worker')!.dependsOn).toEqual(['api']);
    expect(tasks.get('ui')!.dependsOn).toEqual(['api']);
    expect([...tasks.get('verify')!.dependsOn].sort()).toEqual(['ui', 'worker']);
    expect(tasks.get('verify')!.kind).toBe('test');
    for (const task of tasks.values()) expect(task.status).toBe('completed');
    // Fan-in: QA started only after both branches finished.
    const joined = [tasks.get('worker')!, tasks.get('ui')!].map((t) => t.finishedAt!).sort().at(-1)!;
    expect(tasks.get('verify')!.startedAt! >= joined).toBe(true);
  });

  test('WF-04: a quality gate with maxRounds 1 runs one fix round, then the run fails and blocks the rest', async () => {
    const samples = prepareSamples((script) => {
      const qa = structuredClone(script.tasks['api-tests']) as { files: { path: string; content: string }[] };
      qa.files[0].content = BROKEN_TEST;
      script.tasks.verify = qa;
      script.tasks['fix-verify-1'] = note('fix-verify-1');
    });
    const studio = await startStudio(tempDir('wf04'), samples);
    studios.push(studio);
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node('start', 'trigger'), node('verify', 'qa'), node('gate', 'quality-gate', { maxRounds: 1 }), node('repair', 'fix'),
        node('done', 'notify')],
      edges: [edge('start', 'verify'), edge('verify', 'gate'), edge('gate', 'done', { sourceHandle: 'pass' }),
        edge('gate', 'repair', { sourceHandle: 'fail' }), edge('repair', 'verify', { kind: 'retry' })],
    };
    const { projectId, runId } = await runWorkflow(studio, 'Gate', graph);
    const run = await finished(studio, runId);
    const tasks = tasksOf(studio, runId);

    expect(run.status).toBe('failed');
    expect(projectOf(studio, projectId).status).toBe('failed');
    expect(tasks.get('verify')!.options.fixRoundsMax).toBe(1);
    expect(tasks.get('fix-verify-1')?.status).toBe('completed');
    expect(tasks.has('fix-verify-2')).toBe(false);
    expect(tasks.get('verify')!.status).toBe('failed');
    expect(tasks.get('verify')!.testResult?.passed).toBe(false);
    expect(tasks.get('done')!.status).toBe('blocked');
    expect(fixRoundsUsed(studio.ctx, runId, 'verify')).toBe(1);
    expect(run.errorSummary).toMatch(/^verify:/);

    const timeline = studio.runs.timeline(runId);
    expect(timeline.nodes.find((n) => n.nodeId === 'repair')).toMatchObject({ taskKeys: ['fix-verify-1'], status: 'completed' });
    expect(timeline.nodes.find((n) => n.nodeId === 'verify')?.status).toBe('failed');
  });
});
