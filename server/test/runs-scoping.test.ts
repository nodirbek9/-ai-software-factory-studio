import path from 'node:path';
import type { Run, StudioEvent, Task, WorkflowGraph, WorkflowNodeType } from '@asf/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { Studio } from '../src/app.ts';
import { getSettings } from '../src/orchestrator/context.ts';
import { compileWorkflow } from '../src/workflows/compile.ts';
import { git } from '../src/workspace/git.ts';
import { approvePlan, prepareSamples, projectOf, startStudio, tempDir, waitFor } from './helpers.ts';

// Run scoping (WORKFLOW_ENGINE_SPEC.md §3, §8): WF-06/07/08/11, onFailure 'continue', tool and notify nodes. Runs after
// the first are started directly through the repositories (compile + insert), the way RunService.start does it.

let studios: Studio[] = [];

afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

async function open(dataDir: string, samplesDir: string): Promise<Studio> {
  const studio = await startStudio(dataDir, samplesDir);
  studios.push(studio);
  return studio;
}

type NodeSpec = [id: string, type: WorkflowNodeType, config?: Record<string, unknown>];

/** A linear workflow: Start → each node in order. */
function chain(...specs: NodeSpec[]): WorkflowGraph {
  const all: NodeSpec[] = [['start', 'trigger'], ...specs];
  const nodes = all.map(([id, type, config], i) => ({ id, type, position: { x: i * 220, y: 0 }, config: config ?? {} }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `e${i + 1}`, source: nodes[i].id, target: node.id }));
  return { schemaVersion: 1, nodes, edges };
}

/** Creates a run of `graph`, inserts its compiled tasks and lets the scheduler start it (optionally without a tick). */
async function startRun(studio: Studio, projectId: string, graph: WorkflowGraph, options: { tick?: boolean } = {}): Promise<Run> {
  const { repos } = studio.ctx;
  const project = projectOf(studio, projectId);
  const compiled = compileWorkflow(graph, { maxAttempts: getSettings(studio.ctx).defaultMaxAttempts, testCommand: project.testCommand });
  const baseCommit = await git(project.integrationPath!, ['rev-parse', 'HEAD']);
  const run = repos.runs.create({ projectId, workflowId: null, workflowName: 'Test workflow', workflowVersion: null, snapshot: graph,
    trigger: 'manual', baseCommit });
  for (const task of compiled.tasks) repos.tasks.create(projectId, { ...task, runId: run.id });
  studio.scheduler.setProjectStatus(project, 'running', 'Run started');
  if (options.tick !== false) studio.scheduler.tick(projectId);
  return repos.runs.get(run.id)!;
}

const runOf = (studio: Studio, id: string): Run => studio.ctx.repos.runs.get(id)!;
const finishedRun = (studio: Studio, id: string, label: string): Promise<Run> =>
  waitFor(() => { const run = runOf(studio, id); return run.finishedAt ? run : null; }, 120_000, label);
const taskOf = (studio: Studio, runId: string, key: string): Task => studio.ctx.repos.tasks.listByRun(runId).find((t) => t.key === key)!;
const events = (studio: Studio, projectId: string): StudioEvent[] => studio.ctx.repos.events.list({ projectId, limit: 5000 });
const describeTasks = (studio: Studio, runId: string): string =>
  JSON.stringify(studio.ctx.repos.tasks.listByRun(runId).map((t) => [t.key, t.status, t.error]));

/** A Scripted provider entry that writes docs/<key>.md. */
const noteEntry = (key: string): Record<string, unknown> => ({ delayMs: 200, summary: `Wrote ${key}.`, files: [{ path: `docs/${key}.md`, content: `${key}\n` }] });

describe('workflow runs are scoped', () => {
  test('WF-06: a second run after a completed run gets its own task rows; run 1 is untouched', async () => {
    const studio = await open(tempDir('runs-two'), prepareSamples());
    const project = await studio.projects.create({ name: 'Twice', spec: '', workspaceMode: 'sample', sampleName: 'todo-service', testCommand: 'npm test' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 120_000, 'run 1');
    const run1 = studio.ctx.repos.runs.latestForProject(project.id)!;
    expect(projectOf(studio, project.id).status, describeTasks(studio, run1.id)).toBe('completed');
    expect(run1).toMatchObject({ number: 1, status: 'completed', errorSummary: null });
    expect(run1.finishedAt).toBeTruthy();
    const run1Tasks = studio.ctx.repos.tasks.listByRun(run1.id);
    const marker = Math.max(...events(studio, project.id).map((e) => e.id));

    const run2 = await startRun(studio, project.id, chain(
      ['check', 'tool', { command: 'node --test' }],
      ['done', 'notify', { message: '{{project}} run {{run}}: {{status}}' }],
    ));
    expect(run2.number).toBe(2);
    const finished = await finishedRun(studio, run2.id, 'run 2');
    expect(finished.status, describeTasks(studio, run2.id)).toBe('completed');
    expect(projectOf(studio, project.id).status).toBe('completed');

    // Run 1's rows and status did not change; run 2 has its own rows (same keys may repeat across runs).
    expect(studio.ctx.repos.tasks.listByRun(run1.id)).toEqual(run1Tasks);
    expect(runOf(studio, run1.id)).toMatchObject({ status: 'completed', finishedAt: run1.finishedAt });
    expect(studio.ctx.repos.tasks.listByRun(run2.id).map((t) => [t.key, t.kind, t.status])).toEqual([
      ['check', 'command', 'completed'], ['done', 'notify', 'completed']]);
    expect(studio.ctx.repos.tasks.listByProject(project.id)).toHaveLength(run1Tasks.length + 2);
    expect(taskOf(studio, run2.id, 'check').resultSummary).toMatch(/^node --test: exit 0/);
    expect(taskOf(studio, run2.id, 'done').resultSummary).toBe('Twice run 2: running');

    const later = events(studio, project.id).filter((e) => e.id > marker && e.type === 'run.updated');
    const runIdOf = (e: StudioEvent): string => (e.data?.run as Run).id;
    expect(later.some((e) => runIdOf(e) === run1.id)).toBe(false);
    expect(later.filter((e) => runIdOf(e) === run2.id).map((e) => (e.data?.run as Run).status)).toContain('completed');
    const note = events(studio, project.id).find((e) => e.type === 'notification');
    expect(note).toMatchObject({ level: 'info', message: 'Twice run 2: running', data: { message: 'Twice run 2: running', runId: run2.id } });
  });

  test('WF-07: cancelling mid-run cancels the run and records finishedAt', async () => {
    const studio = await open(tempDir('runs-cancel'), prepareSamples((script) => { script.tasks.slow = { ...noteEntry('slow'), delayMs: 20_000 }; }));
    const project = await studio.projects.create({ name: 'Cancel me', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const run = await startRun(studio, project.id, chain(['slow', 'backend', { title: 'Slow step' }], ['done', 'notify']));
    await waitFor(() => taskOf(studio, run.id, 'slow').status === 'running', 30_000, 'slow running');
    expect(runOf(studio, run.id).status).toBe('running');

    studio.scheduler.cancelProject(project.id);
    await waitFor(() => taskOf(studio, run.id, 'slow').status === 'cancelled', 30_000, 'slow cancelled');
    const cancelled = runOf(studio, run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).toBeTruthy();
    expect(taskOf(studio, run.id, 'done').status).toBe('cancelled');
    expect(projectOf(studio, project.id).status).toBe('cancelled');
    expect(events(studio, project.id).some((e) => e.type === 'notification')).toBe(false);
  });

  test('WF-08: after a restart, recovery continues the same run', async () => {
    const dataDir = tempDir('runs-recover');
    const samples = prepareSamples((script) => { script.tasks.step = noteEntry('step'); });
    const first = await open(dataDir, samples);
    const project = await first.projects.create({ name: 'Restart', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const run = await startRun(first, project.id, chain(['step', 'backend', { title: 'One step' }], ['done', 'notify']), { tick: false });
    await first.close();
    studios = [];

    // Simulate a hard crash in the middle of the step.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(dataDir, 'studio.db'));
    raw.prepare(`UPDATE tasks SET status = 'running', checkpoint = 'agent_done', attempt = 1 WHERE run_id = ? AND key = 'step'`).run(run.id);
    raw.close();

    const second = await open(dataDir, samples);
    const finished = await finishedRun(second, run.id, 'recovered run');
    expect(finished.status, describeTasks(second, run.id)).toBe('completed');
    expect(second.ctx.repos.runs.listByProject(project.id).runs.map((r) => r.id)).toEqual([run.id]);
    expect(taskOf(second, run.id, 'step')).toMatchObject({ status: 'completed', attempt: 2 });
    expect(events(second, project.id).some((e) => e.message.includes('interrupted at checkpoint "agent_done"'))).toBe(true);
    expect(projectOf(second, project.id).status).toBe('completed');
  });

  test("onFailure 'continue': dependants run and the run ends completed_with_failures; 'stop' blocks them", async () => {
    const studio = await open(tempDir('runs-continue'), prepareSamples((script) => { script.tasks.after = noteEntry('after'); }));
    const graphWith = (onFailure: 'stop' | 'continue'): WorkflowGraph => chain(
      // "boom" has no script entry, so the Scripted provider fails it permanently. "after" names its provider (agent override).
      ['boom', 'backend', { title: 'Failing step', onFailure }],
      ['after', 'frontend', { title: 'Next step', providerId: 'scripted', model: 'replay' }],
      ['done', 'notify'],
    );
    const tolerant = await studio.projects.create({ name: 'Tolerant', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const strict = await studio.projects.create({ name: 'Strict', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const continued = await startRun(studio, tolerant.id, graphWith('continue'));
    const stopped = await startRun(studio, strict.id, graphWith('stop'));

    const run = await finishedRun(studio, continued.id, 'tolerant run');
    expect(run.status, describeTasks(studio, run.id)).toBe('completed_with_failures');
    expect(run.errorSummary).toMatch(/^boom: /);
    expect(taskOf(studio, run.id, 'boom').status).toBe('failed');
    expect(taskOf(studio, run.id, 'after')).toMatchObject({ status: 'completed', providerId: 'scripted', options: { providerId: 'scripted' } });
    expect(taskOf(studio, run.id, 'done').status).toBe('completed');
    expect(projectOf(studio, tolerant.id).status).toBe('completed');

    const strictRun = await finishedRun(studio, stopped.id, 'strict run');
    expect(strictRun.status).toBe('failed');
    expect(taskOf(studio, strictRun.id, 'after').status).toBe('blocked');
    expect(taskOf(studio, strictRun.id, 'done').status).toBe('blocked');
    expect(projectOf(studio, strict.id).status).toBe('failed');
  });

  test('WF-11: a non-allowlisted command asks for approval, then runs; a non-zero exit is a plain failure', async () => {
    const studio = await open(tempDir('runs-command'), prepareSamples());
    const project = await studio.projects.create({ name: 'Cmd', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const run = await startRun(studio, project.id, chain(
      ['probe', 'tool', { command: 'node --version' }], ['done', 'notify', { message: '{{project}} run {{run}}: {{status}}' }],
    ));
    const failed = await finishedRun(studio, run.id, 'command denied');
    expect(failed.status).toBe('failed');
    expect(taskOf(studio, run.id, 'probe')).toMatchObject({ status: 'failed', attempt: 1 });
    expect(taskOf(studio, run.id, 'probe').error).toMatch(/Command "node --version" needs approval/);
    expect(taskOf(studio, run.id, 'done').status).toBe('blocked');
    const approval = studio.ctx.repos.approvals.listByProject(project.id).find((a) => a.kind === 'command' && a.status === 'pending')!;
    expect(approval.details.command).toBe('node --version');

    studio.projects.decideApproval(approval.id, 'approved', null);
    const completed = await waitFor(() => runOf(studio, run.id).status === 'completed' && runOf(studio, run.id), 60_000, 'approved run');
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.errorSummary).toBeNull();
    expect(taskOf(studio, run.id, 'probe').resultSummary).toMatch(/^node --version: exit 0\n\nv\d+/);
    const note = events(studio, project.id).find((e) => e.type === 'notification')!;
    expect(note.data).toEqual({ message: 'Cmd run 1: running', runId: run.id });

    // npm run build: allowlisted, but the sample has no build script → exit 1 → retried, then failed; no fix round.
    const other = await studio.projects.create({ name: 'Build', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const buildRun = await startRun(studio, other.id, chain(['build', 'tool', { command: 'npm run build' }]));
    const red = await finishedRun(studio, buildRun.id, 'red command');
    expect(red.status).toBe('failed');
    const build = taskOf(studio, buildRun.id, 'build');
    expect(build).toMatchObject({ status: 'failed', attempt: build.maxAttempts });
    expect(build.error).toMatch(/npm run build: exit 1/);
    expect(studio.ctx.repos.tasks.listByRun(buildRun.id).map((t) => t.key)).toEqual(['build']);
  });
});
