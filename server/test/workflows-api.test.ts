import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import type { Project, Run, RunsPage, RunTimeline, SimulationResult, ValidationResult, Workflow, WorkflowGraph, WorkflowSummary } from '@asf/shared';
import { STANDARD_WORKFLOW_ID } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import { NODE_CATALOG } from '../src/workflows/catalog.ts';
import { STANDARD_WORKFLOW_GRAPH } from '../src/workflows/standardTemplate.ts';
import { createRun, prepareSamples, projectOf, tempDir, waitFor } from './helpers.ts';

// Workflow + run API (WORKFLOW_ENGINE_SPEC.md §7): CRUD, builtin protection, WF-10 export/import, validate/simulate,
// one active run per project, multi-run, pagination, timeline and confirm-protected cancel. Scripted provider only.

const studios: Studio[] = [];
afterAll(async () => { for (const s of studios) await s.close(); });

async function studio(): Promise<Studio> {
  const dataDir = tempDir('wfapi');
  const s = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] });
  studios.push(s);
  return s;
}

interface Reply<T> { status: number; body: T; headers: Record<string, unknown> }

async function call<T = any>(s: Studio, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Reply<T>> {
  const res = await s.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

const at = (x: number) => ({ x, y: 0 });
const NOTIFY_GRAPH: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', type: 'trigger', label: 'Start', position: at(0), config: {} },
    { id: 'notify-done', type: 'notify', label: 'Tell me', position: at(200), config: { message: '{{project}} run {{run}}' } },
  ],
  edges: [{ id: 'start->notify-done', source: 'start', target: 'notify-done' }],
};
/** Well formed but not runnable: no Start node. */
const DRAFT_GRAPH: WorkflowGraph = { ...NOTIFY_GRAPH, nodes: NOTIFY_GRAPH.nodes.slice(1), edges: [] };

function plainProject(s: Studio, name: string): Project {
  return s.ctx.repos.projects.create({ name, slug: name.toLowerCase().replace(/\s+/g, '-'), description: '', spec: 'spec',
    workspaceMode: 'new', workspacePath: tempDir('wfws'), testCommand: '' });
}

describe('workflow CRUD', () => {
  test('lists the builtin template and serves the node catalog', async () => {
    const s = await studio();
    const list = await call<{ workflows: WorkflowSummary[] }>(s, 'GET', '/api/v2/workflows');
    expect(list.status).toBe(200);
    expect(list.body.workflows.find((w) => w.id === STANDARD_WORKFLOW_ID)).toMatchObject({ builtin: true, projectId: null });
    expect('graph' in list.body.workflows[0]).toBe(false);
    const catalog = await call<{ nodes: { type: string }[] }>(s, 'GET', '/api/v2/workflows/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.body.nodes.map((n) => n.type)).toEqual(NODE_CATALOG.map((n) => n.type));
  });

  test('create, read, update (version bump) and archive; drafts save, malformed graphs do not', async () => {
    const s = await studio();
    const project = plainProject(s, 'Crud');
    const created = await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows', { name: 'Notify', projectId: project.id, graph: NOTIFY_GRAPH });
    expect(created.status).toBe(201);
    const { id } = created.body.workflow;
    expect(created.body.workflow).toMatchObject({ version: 1, builtin: false, projectId: project.id, nodeCount: 2 });

    const read = await call<{ workflow: Workflow }>(s, 'GET', `/api/v2/workflows/${id}`);
    expect(read.body.workflow.graph).toEqual(NOTIFY_GRAPH);
    const updated = await call<{ workflow: Workflow }>(s, 'PUT', `/api/v2/workflows/${id}`, { name: 'Notify v2', graph: DRAFT_GRAPH });
    expect(updated.status).toBe(200);
    expect(updated.body.workflow).toMatchObject({ name: 'Notify v2', version: 2, projectId: project.id, nodeCount: 1 });

    const global = await call<{ workflows: WorkflowSummary[] }>(s, 'GET', '/api/v2/workflows');
    expect(global.body.workflows.some((w) => w.id === id)).toBe(false);
    const scoped = await call<{ workflows: WorkflowSummary[] }>(s, 'GET', `/api/v2/workflows?projectId=${project.id}`);
    expect(scoped.body.workflows.some((w) => w.id === id)).toBe(true);

    expect((await call(s, 'DELETE', `/api/v2/workflows/${id}`, {})).status).toBe(400);
    const archived = await call<{ workflow: Workflow }>(s, 'DELETE', `/api/v2/workflows/${id}`, { confirm: true });
    expect(archived.body.workflow.archived).toBe(true);
    const after = await call<{ workflows: WorkflowSummary[] }>(s, 'GET', `/api/v2/workflows?projectId=${project.id}`);
    expect(after.body.workflows.some((w) => w.id === id)).toBe(false);

    const badId = { ...NOTIFY_GRAPH, nodes: [{ ...NOTIFY_GRAPH.nodes[0], id: 'Bad Id' }] };
    const malformed = await call<{ details: ValidationResult }>(s, 'POST', '/api/v2/workflows', { name: 'Bad', graph: badId });
    expect(malformed.status).toBe(400);
    expect(malformed.body.details.errors[0].code).toBe('E_CONFIG');
    const huge = { ...NOTIFY_GRAPH, nodes: Array.from({ length: 61 }, (_, i) => ({ ...NOTIFY_GRAPH.nodes[1], id: `n-${i}` })) };
    const tooBig = await call<{ details: ValidationResult }>(s, 'POST', '/api/v2/workflows', { name: 'Huge', graph: huge });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.details.errors.map((e) => e.code)).toContain('E_LIMIT');
    expect((await call(s, 'POST', '/api/v2/workflows', { name: 'Nowhere', projectId: randomUUID(), graph: NOTIFY_GRAPH })).status).toBe(404);
    expect((await call(s, 'GET', '/api/v2/workflows/missing')).status).toBe(404);
  });

  test('the builtin template is read-only; duplicate makes an editable copy', async () => {
    const s = await studio();
    expect((await call(s, 'PUT', `/api/v2/workflows/${STANDARD_WORKFLOW_ID}`, { name: 'Mine', graph: NOTIFY_GRAPH })).status).toBe(403);
    expect((await call(s, 'DELETE', `/api/v2/workflows/${STANDARD_WORKFLOW_ID}`, { confirm: true })).status).toBe(403);

    const copy = await call<{ workflow: Workflow }>(s, 'POST', `/api/v2/workflows/${STANDARD_WORKFLOW_ID}/duplicate`, {});
    expect(copy.status).toBe(201);
    expect(copy.body.workflow).toMatchObject({ name: 'Copy of Standard Software Factory', builtin: false, projectId: null, version: 1 });
    expect(copy.body.workflow.graph).toEqual(STANDARD_WORKFLOW_GRAPH);
    const project = plainProject(s, 'Dup');
    const scoped = await call<{ workflow: Workflow }>(s, 'POST', `/api/v2/workflows/${copy.body.workflow.id}/duplicate`, { projectId: project.id });
    expect(scoped.body.workflow).toMatchObject({ name: 'Copy of Copy of Standard Software Factory', projectId: project.id });
    const edited = await call<{ workflow: Workflow }>(s, 'PUT', `/api/v2/workflows/${copy.body.workflow.id}`, { name: 'Edited', graph: NOTIFY_GRAPH });
    expect(edited.body.workflow.version).toBe(2);
  });

  test('WF-10 export → import round trip never keeps foreign ids', async () => {
    const s = await studio();
    const owner = plainProject(s, 'Owner');
    const other = plainProject(s, 'Other');
    const source = (await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows',
      { name: 'Shared flow', description: 'notify only', projectId: owner.id, graph: NOTIFY_GRAPH })).body.workflow;

    const exported = await call<{ name: string; description: string; graph: WorkflowGraph }>(s, 'GET', `/api/v2/workflows/${source.id}/export`);
    expect(exported.status).toBe(200);
    expect(String(exported.headers['content-disposition'])).toMatch(/^attachment; filename="shared-flow\.workflow\.json"$/);
    expect(exported.body).toEqual({ name: 'Shared flow', description: 'notify only', graph: NOTIFY_GRAPH });

    const json = { ...exported.body, id: source.id, projectId: owner.id };
    const imported = await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows/import', { projectId: other.id, json });
    expect(imported.status).toBe(201);
    expect(imported.body.workflow.id).not.toBe(source.id);
    expect(imported.body.workflow).toMatchObject({ name: 'Shared flow', description: 'notify only', projectId: other.id, builtin: false, version: 1 });
    expect(imported.body.workflow.graph).toEqual(NOTIFY_GRAPH);

    const bare = await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows/import', { projectId: other.id, json: STANDARD_WORKFLOW_GRAPH });
    expect(bare.body.workflow).toMatchObject({ name: 'Imported workflow', projectId: other.id });
    expect(bare.body.workflow.graph).toEqual(STANDARD_WORKFLOW_GRAPH);
    expect((await call(s, 'POST', '/api/v2/workflows/import', { projectId: other.id, json: { name: 'x', graph: { nodes: 'no' } } })).status).toBe(400);
    expect((await call(s, 'POST', '/api/v2/workflows/import', { projectId: other.id, json: 'not an object' })).status).toBe(400);
  });

  test('validate and simulate (Standard: plan, architecture, plan-approval, then the tail)', async () => {
    const s = await studio();
    const ok = await call<ValidationResult>(s, 'POST', '/api/v2/workflows/validate', { graph: STANDARD_WORKFLOW_GRAPH });
    expect(ok.body).toMatchObject({ ok: true, errors: [] });
    const planned = { ...NOTIFY_GRAPH, nodes: [...NOTIFY_GRAPH.nodes, { id: 'wait', type: 'delay', position: at(400), config: {} }],
      edges: [...NOTIFY_GRAPH.edges, { id: 'n->w', source: 'notify-done', target: 'wait' }] };
    const blocked = await call<ValidationResult>(s, 'POST', '/api/v2/workflows/validate', { graph: planned });
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.errors.map((e) => e.code)).toContain('E_PLANNED');

    const sim = await call<SimulationResult>(s, 'POST', `/api/v2/workflows/${STANDARD_WORKFLOW_ID}/simulate`, {});
    expect(sim.status).toBe(200);
    expect(sim.body.validation.ok).toBe(true);
    expect(sim.body.tasks.map((t) => t.key)).toEqual(['plan', 'architecture', 'plan-approval', 'security-review', 'final-review', 'delivery-report']);
    expect(sim.body.tasks.find((t) => t.key === 'plan-approval')).toMatchObject({ kind: 'gate', dependsOn: ['architecture'], nodeId: 'plan-approval' });
    expect(sim.body.notes.length).toBeGreaterThan(0);

    const draft = (await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows', { name: 'Draft', graph: DRAFT_GRAPH })).body.workflow;
    const invalid = await call<SimulationResult>(s, 'POST', `/api/v2/workflows/${draft.id}/simulate`, {});
    expect(invalid.body.validation.errors.map((e) => e.code)).toContain('E_TRIGGER');
    expect(invalid.body.tasks).toEqual([]);
  });
});

describe('runs', () => {
  test('a completed project starts run 2; run 1 stays untouched; runs are paged', async () => {
    const s = await studio();
    const project = plainProject(s, 'Multi');
    const workflow = (await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows', { name: 'Notify', projectId: project.id, graph: NOTIFY_GRAPH })).body.workflow;
    const draft = (await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows', { name: 'Draft', projectId: project.id, graph: DRAFT_GRAPH })).body.workflow;

    const invalid = await call<{ details: ValidationResult }>(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: draft.id });
    expect(invalid.status).toBe(422);
    expect(invalid.body.details.errors.map((e) => e.code)).toContain('E_TRIGGER');
    expect((await call(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: 'missing' })).status).toBe(404);
    const foreign = (await call<{ workflow: Workflow }>(s, 'POST', '/api/v2/workflows', { name: 'Foreign', projectId: plainProject(s, 'Elsewhere').id, graph: NOTIFY_GRAPH })).body.workflow;
    expect((await call(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: foreign.id })).status).toBe(404);

    const first = await call<{ run: Run }>(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: workflow.id });
    expect(first.status).toBe(201);
    expect(first.body.run).toMatchObject({ number: 1, workflowId: workflow.id, workflowName: 'Notify', trigger: 'manual', tasksTotal: 1 });
    await waitFor(() => projectOf(s, project.id).status === 'completed', 30_000, 'run 1 completed');
    const run1 = s.ctx.repos.runs.get(first.body.run.id)!;
    expect(run1.status).toBe('completed');
    expect(run1.finishedAt).not.toBeNull();
    const run1Tasks = s.ctx.repos.tasks.listByRun(run1.id);

    const second = await call<{ run: Run }>(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: workflow.id });
    expect(second.status).toBe(201);
    expect(second.body.run.number).toBe(2);
    await waitFor(() => s.ctx.repos.runs.get(second.body.run.id)?.status === 'completed', 30_000, 'run 2 completed');
    expect(s.ctx.repos.runs.get(run1.id)).toEqual(run1);
    expect(s.ctx.repos.tasks.listByRun(run1.id)).toEqual(run1Tasks);
    expect(s.ctx.repos.tasks.listByRun(second.body.run.id).map((t) => t.key)).toEqual(['notify-done']);

    const timeline = await call<RunTimeline>(s, 'GET', `/api/v2/runs/${second.body.run.id}/timeline`);
    expect(timeline.body.nodes).toEqual([expect.objectContaining({ nodeId: 'notify-done', status: 'completed', attempts: 1, taskKeys: ['notify-done'] })]);
    expect(timeline.body.entries.some((e) => e.type === 'notification' && e.nodeId === 'notify-done')).toBe(true);

    createRun(s.ctx.repos, project.id, 'completed');
    const page1 = await call<RunsPage>(s, 'GET', `/api/v2/projects/${project.id}/runs?limit=2`);
    expect(page1.body.runs.map((r) => r.number)).toEqual([3, 2]);
    expect(page1.body.nextBefore).toBe(2);
    const page2 = await call<RunsPage>(s, 'GET', `/api/v2/projects/${project.id}/runs?limit=2&before=2`);
    expect(page2.body).toMatchObject({ nextBefore: null });
    expect(page2.body.runs.map((r) => r.number)).toEqual([1]);
    expect((await call(s, 'GET', `/api/v2/projects/${project.id}/runs?limit=51`)).status).toBe(400);
    expect((await call<{ run: Run }>(s, 'GET', `/api/v2/runs/${run1.id}`)).body.run.id).toBe(run1.id);
    expect((await call(s, 'GET', '/api/v2/runs/missing')).status).toBe(404);
  });

  test('Standard run: 409 while active, timeline node statuses, cancel needs confirm, then run 2', async () => {
    const s = await studio();
    const project = await s.projects.create({ name: 'Standard Run', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    const started = await call<{ run: Run }>(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: STANDARD_WORKFLOW_ID });
    expect(started.status).toBe(201);
    const run = started.body.run;
    expect(run).toMatchObject({ number: 1, status: 'planning', tasksTotal: 3 });
    expect(run.baseCommit).toBe(project.baseCommit);
    expect((await call(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: STANDARD_WORKFLOW_ID })).status).toBe(409);
    expect((await call(s, 'POST', `/api/projects/${project.id}/plan`, {})).status).toBe(409);

    await waitFor(() => projectOf(s, project.id).status === 'awaiting_approval', 60_000, 'awaiting approval');
    const timeline = (await call<RunTimeline>(s, 'GET', `/api/v2/runs/${run.id}/timeline`)).body;
    const node = (id: string) => timeline.nodes.find((n) => n.nodeId === id);
    expect(node('plan')).toMatchObject({ status: 'completed', attempts: 1, taskKeys: ['plan'] });
    expect(node('architecture')?.status).toBe('completed');
    expect(node('plan-approval')?.status).toBe('waiting_approval');
    expect(node('backend')).toMatchObject({ status: 'pending', taskKeys: ['todo-store', 'http-api'] });
    expect(node('frontend')).toMatchObject({ status: 'pending', taskKeys: ['web-ui'] });
    expect(node('qa-verify')).toMatchObject({ status: 'pending', taskKeys: ['api-tests'] });
    expect(node('qa-fix')).toMatchObject({ status: 'not_started', taskKeys: [] });
    expect(node('trigger')).toBeUndefined();
    expect(timeline.graph).toEqual(STANDARD_WORKFLOW_GRAPH);
    expect(timeline.entries.some((e) => e.type === 'run.created')).toBe(true);
    expect(timeline.entries.some((e) => e.nodeId === 'plan')).toBe(true);
    expect(timeline.entries.every((e, i, all) => i === 0 || all[i - 1].id < e.id)).toBe(true);

    expect((await call(s, 'POST', `/api/v2/runs/${run.id}/cancel`, {})).status).toBe(400);
    const cancelled = await call<{ run: Run }>(s, 'POST', `/api/v2/runs/${run.id}/cancel`, { confirm: true });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe('cancelled');
    expect(projectOf(s, project.id).status).toBe('cancelled');
    expect((await call(s, 'POST', `/api/v2/runs/${run.id}/cancel`, { confirm: true })).status).toBe(409);

    const next = await call<{ run: Run }>(s, 'POST', `/api/v2/projects/${project.id}/runs`, { workflowId: STANDARD_WORKFLOW_ID });
    expect(next.status).toBe(201);
    expect(next.body.run.number).toBe(2);
    // The V1 snapshot shows the current run only.
    const snapshot = await call<{ tasks: { key: string; runId: string }[] }>(s, 'GET', `/api/projects/${project.id}`);
    expect(snapshot.body.tasks.map((t) => t.key)).toContain('plan');
    expect(snapshot.body.tasks.every((t) => t.runId === next.body.run.id)).toBe(true);
    expect(s.ctx.repos.tasks.listByRun(run.id).filter((t) => t.status === 'cancelled').length).toBeGreaterThan(0);
    await waitFor(() => projectOf(s, project.id).status === 'awaiting_approval', 60_000, 'run 2 awaiting approval');
  });
});
