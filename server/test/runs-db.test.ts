import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { STANDARD_WORKFLOW_ID, type WorkflowGraph, type WorkflowNode } from '@asf/shared';
import { openDatabase, SCHEMA_VERSION, type Db } from '../src/db/database.ts';
import { createRepositories, type Repositories } from '../src/db/repositories.ts';
import { WorkflowStoreError } from '../src/db/runRepositories.ts';
import type { StudioContext } from '../src/orchestrator/context.ts';
import { fixRoundsUsed, insertFixTask } from '../src/orchestrator/fixLoop.ts';
import { STANDARD_WORKFLOW, STANDARD_WORKFLOW_GRAPH } from '../src/workflows/standardTemplate.ts';
import { createRun, tempDir } from './helpers.ts';

type Row = Record<string, unknown>;

let open: Db[] = [];
afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function track(db: Db): Db {
  open.push(db);
  return db;
}

function setup(): { db: Db; repos: Repositories; newProject: (slug: string) => string } {
  const db = track(openDatabase(path.join(tempDir('runsdb'), 'studio.db')));
  const repos = createRepositories(db);
  const newProject = (slug: string): string => repos.projects.create({ name: slug, slug, description: '', spec: 'spec',
    workspaceMode: 'new', workspacePath: `/tmp/${slug}`, testCommand: 'npm test' }).id;
  return { db, repos, newProject };
}

const all = (db: Db, query: string): Row[] => db.prepare(query).all() as Row[];
const count = (db: Db, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

/** A database at the schema before the runs migration, holding V1-shaped projects, tasks, usage and fix-round settings. */
function seedOldDatabase(file: string): void {
  const db = openDatabase(file, { upToVersion: 3 }); // schema just before the runs migration (index 3)
  const project = db.prepare(`INSERT INTO projects (id, name, slug, spec, status, workspace_mode, workspace_path, base_commit, test_command,
    created_at, updated_at) VALUES (?, ?, ?, 'spec', ?, 'new', '/tmp/x', ?, 'npm test', ?, ?)`);
  project.run('p1', 'One', 'one', 'completed', 'abc123', '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z');
  project.run('p2', 'Two', 'two', 'running', null, '2026-10-02T10:00:00.000Z', '2026-10-02T10:30:00.000Z');
  project.run('p3', 'Three', 'three', 'draft', null, '2026-10-03T10:00:00.000Z', '2026-10-03T10:00:00.000Z');
  const task = db.prepare(`INSERT INTO tasks (id, project_id, key, title, role, kind, status, depends_on, order_index, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T10:00:00.000Z')`);
  task.run('t1', 'p1', 'plan', 'Plan', 'pm', 'plan', 'completed', '[]', 1);
  task.run('t2', 'p1', 'qa-verify', 'QA', 'qa', 'test', 'completed', '["plan"]', 2);
  task.run('t3', 'p2', 'plan', 'Plan', 'pm', 'plan', 'running', '[]', 1);
  const usage = db.prepare(`INSERT INTO usage_records (project_id, task_id, role, provider_id, input_tokens, output_tokens, cost_usd, created_at)
    VALUES (?, ?, 'qa', 'claude-code', 10, 5, ?, '2026-10-01T10:30:00.000Z')`);
  usage.run('p1', 't2', 0.5);
  usage.run(null, null, null);
  db.prepare("INSERT INTO settings (key, value) VALUES ('fixRounds:p1:qa-verify', '2')").run();
  db.close();
}

describe('migration to runs (P4-1)', () => {
  test('backfills one run per project and keeps every row', () => {
    const dir = tempDir('runsmig');
    const file = path.join(dir, 'studio.db');
    seedOldDatabase(file);

    const db = track(openDatabase(file));
    expect(Number((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version)).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(path.join(dir, 'backups', `studio-before-v${SCHEMA_VERSION}.db`))).toBe(true);
    expect([count(db, 'projects'), count(db, 'tasks'), count(db, 'usage_records')]).toEqual([3, 3, 2]);

    const runs = all(db, 'SELECT * FROM runs ORDER BY id');
    expect(runs.map((r) => [r.id, r.project_id, r.number, r.status, r.trigger, r.base_commit, r.started_at, r.finished_at])).toEqual([
      ['run-p1', 'p1', 1, 'completed', 'backfill', 'abc123', '2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z'],
      ['run-p2', 'p2', 1, 'running', 'backfill', null, '2026-10-02T10:00:00.000Z', null],
    ]);
    expect(JSON.parse(String(runs[0].workflow_snapshot))).toEqual(STANDARD_WORKFLOW_GRAPH);
    expect(runs[0]).toMatchObject({ workflow_id: STANDARD_WORKFLOW_ID, workflow_version: 1, workflow_name: STANDARD_WORKFLOW.name });

    expect(all(db, "SELECT id FROM tasks WHERE run_id != 'run-' || project_id")).toEqual([]);
    expect(all(db, 'SELECT id, options, node_id FROM tasks ORDER BY id')).toEqual([
      { id: 't1', options: '{}', node_id: null }, { id: 't2', options: '{}', node_id: null }, { id: 't3', options: '{}', node_id: null },
    ]);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks' AND name LIKE 'idx_%' ORDER BY name").map((r) => r.name))
      .toEqual(['idx_tasks_project', 'idx_tasks_run']);
    expect(all(db, 'SELECT task_id, run_id FROM usage_records ORDER BY id')).toEqual([
      { task_id: 't2', run_id: 'run-p1' }, { task_id: null, run_id: null },
    ]);
    expect(all(db, "SELECT key, value FROM settings WHERE key LIKE 'fixRounds:%' ORDER BY key")).toEqual([
      { key: 'fixRounds:p1:qa-verify', value: '2' }, { key: 'fixRounds:run-p1:qa-verify', value: '2' },
    ]);
    expect(all(db, 'SELECT id, project_id, builtin, version FROM workflows')).toEqual([
      { id: STANDARD_WORKFLOW_ID, project_id: null, builtin: 1, version: 1 },
    ]);

    const repos = createRepositories(db);
    expect(repos.runs.get('run-p1')).toMatchObject({ workflowName: 'Standard Software Factory', tasksTotal: 2, tasksCompleted: 2,
      costUsd: 0.5, durationMs: 3_600_000 });
    expect(repos.runs.get('run-p2')).toMatchObject({ costUsd: null, durationMs: null, tasksTotal: 1 });
    expect(repos.tasks.listByRun('run-p1').map((t) => [t.key, t.runId, t.nodeId, t.options])).toEqual([
      ['plan', 'run-p1', null, {}], ['qa-verify', 'run-p1', null, {}],
    ]);
    // The builtin row is already in sync, so the startup re-sync does not bump its version.
    expect(repos.workflows.ensureBuiltin(STANDARD_WORKFLOW).version).toBe(1);
  });

  test('task keys are unique per run, not per project', () => {
    const { repos, newProject } = setup();
    const projectId = newProject('keys');
    const first = createRun(repos, projectId, 'completed');
    const second = createRun(repos, projectId);
    const task = (runId: string) => repos.tasks.create(projectId, { runId, key: 'plan', title: 'Plan', description: '', role: 'pm',
      kind: 'plan', dependsOn: [], orderIndex: 1, maxAttempts: 2 });
    task(first.id);
    task(second.id);
    expect(() => task(second.id)).toThrow(/UNIQUE/);
    expect(repos.tasks.listByProject(projectId)).toHaveLength(2);
    expect(() => repos.tasks.create(projectId, { runId: 'missing', key: 'x', title: 'X', description: '', role: 'pm', kind: 'plan',
      dependsOn: [], orderIndex: 1, maxAttempts: 1 })).toThrow(/FOREIGN KEY/);
  });
});

describe('TaskRepository run fields', () => {
  test('stores node id and options, lists and orders per run', () => {
    const { repos, newProject } = setup();
    const projectId = newProject('tasks');
    const run = createRun(repos, projectId);
    const other = createRun(repos, projectId);
    const created = repos.tasks.create(projectId, { runId: run.id, nodeId: 'qa-verify', options: { fixRoundsMax: 1, fixRole: 'frontend' },
      key: 'qa-verify', title: 'QA', description: '', role: 'qa', kind: 'test', dependsOn: [], orderIndex: 4, maxAttempts: 2 });
    repos.tasks.create(projectId, { runId: other.id, key: 'plan', title: 'Plan', description: '', role: 'pm', kind: 'plan', dependsOn: [],
      orderIndex: 9, maxAttempts: 2 });
    expect(created).toMatchObject({ runId: run.id, nodeId: 'qa-verify', options: { fixRoundsMax: 1, fixRole: 'frontend' } });
    expect(repos.tasks.update(created.id, { options: { timeoutMinutes: 30 } }).options).toEqual({ timeoutMinutes: 30 });
    expect(repos.tasks.listByRun(run.id).map((t) => t.key)).toEqual(['qa-verify']);
    expect(repos.tasks.maxOrderIndexForRun(run.id)).toBe(4);
    expect(repos.tasks.maxOrderIndexForRun('none')).toBe(0);
    expect(repos.tasks.maxOrderIndex(projectId)).toBe(9);
  });
});

describe('RunRepository', () => {
  test('numbers runs per project, pages newest first and finds the active run', () => {
    const { repos, newProject } = setup();
    const projectId = newProject('runs');
    const otherId = newProject('other');
    const [r1, r2, r3] = [1, 2, 3].map(() => createRun(repos, projectId, 'planning'));
    expect([r1.number, r2.number, r3.number]).toEqual([1, 2, 3]);
    expect(createRun(repos, otherId).number).toBe(1);
    expect(r1).toMatchObject({ workflowId: STANDARD_WORKFLOW_ID, workflowName: 'Standard Software Factory', trigger: 'manual',
      tasksTotal: 0, tasksCompleted: 0, costUsd: null, finishedAt: null, durationMs: null });

    const page1 = repos.runs.listByProject(projectId, { limit: 2 });
    expect(page1.runs.map((r) => r.number)).toEqual([3, 2]);
    expect(page1.nextBefore).toBe(2);
    const page2 = repos.runs.listByProject(projectId, { limit: 2, before: page1.nextBefore! });
    expect(page2.runs.map((r) => r.number)).toEqual([1]);
    expect(page2.nextBefore).toBeNull();

    expect(repos.runs.activeForProject(projectId)?.id).toBe(r3.id);
    const finishedAt = new Date(Date.parse(r3.startedAt) + 5000).toISOString();
    const done = repos.runs.update(r3.id, { status: 'completed', finishedAt, errorSummary: null });
    expect(done).toMatchObject({ status: 'completed', finishedAt, durationMs: 5000 });
    expect(repos.runs.activeForProject(projectId)?.id).toBe(r2.id);
    repos.runs.update(r2.id, { status: 'failed', errorSummary: 'tests red' });
    repos.runs.update(r1.id, { status: 'cancelled' });
    expect(repos.runs.activeForProject(projectId)).toBeNull();
    expect(repos.runs.latestForProject(projectId)?.id).toBe(r3.id);
    expect(repos.runs.get(r2.id)?.errorSummary).toBe('tests red');
    expect(repos.runs.snapshot(r1.id)).toEqual(STANDARD_WORKFLOW_GRAPH);
    expect(repos.runs.snapshot('missing')).toBeNull();
  });

  test('counts tasks, sums measured cost and keeps the workflow name', () => {
    const { repos, newProject } = setup();
    const projectId = newProject('cost');
    const run = createRun(repos, projectId);
    const task = (key: string, status: 'completed' | 'running') => repos.tasks.create(projectId, { runId: run.id, key, title: key,
      description: '', role: 'backend', kind: 'implement', dependsOn: [], orderIndex: 1, maxAttempts: 1, status });
    const a = task('a', 'completed');
    task('b', 'running');
    const record = (costUsd: number | null) => repos.usage.record({ projectId, taskId: a.id, role: 'backend', providerId: 'claude-code',
      model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd }, runId: run.id });
    record(null);
    expect(repos.runs.get(run.id)).toMatchObject({ tasksTotal: 2, tasksCompleted: 1, costUsd: null });
    record(0.25);
    record(0.5);
    expect(repos.runs.get(run.id)?.costUsd).toBeCloseTo(0.75);

    const custom = repos.workflows.create({ name: 'Custom', projectId, graph: STANDARD_WORKFLOW_GRAPH });
    const named = repos.runs.create({ projectId, workflowId: custom.id, workflowVersion: 1, snapshot: custom.graph, trigger: 'manual', baseCommit: 'abc' });
    expect(named).toMatchObject({ workflowName: 'Custom', status: 'planning', baseCommit: 'abc', number: 2 });
    repos.workflows.update(custom.id, { name: 'Renamed', graph: custom.graph });
    expect(repos.runs.get(named.id)?.workflowName).toBe('Renamed');
    const orphan = repos.runs.create({ projectId, workflowId: 'deleted-workflow', workflowName: 'Old name', workflowVersion: 3,
      snapshot: custom.graph, trigger: 'manual', baseCommit: null });
    expect(orphan.workflowName).toBe('Old name');
  });
});

describe('WorkflowRepository', () => {
  const graph = (ids: string[]): WorkflowGraph => ({ schemaVersion: 1, edges: [],
    nodes: ids.map((id, i): WorkflowNode => ({ id, type: i ? 'architect' : 'trigger', position: { x: i * 100, y: 0 }, config: {} })) });

  test('lists globals plus the project templates, saves versions and archives', () => {
    const { repos, newProject } = setup();
    const projectId = newProject('wf');
    const otherId = newProject('wf-other');
    expect(repos.workflows.list()).toEqual([expect.objectContaining({ id: STANDARD_WORKFLOW_ID, builtin: true, archived: false,
      projectId: null, nodeCount: STANDARD_WORKFLOW_GRAPH.nodes.length, name: 'Standard Software Factory' })]);

    const global = repos.workflows.create({ name: 'Global flow', graph: graph(['trigger', 'arch']) });
    const own = repos.workflows.create({ name: 'Own flow', description: 'mine', projectId, graph: graph(['trigger']) });
    expect(own).toMatchObject({ projectId, version: 1, builtin: false, nodeCount: 1, description: 'mine' });
    expect(repos.workflows.list({ projectId }).map((w) => w.id)).toEqual([STANDARD_WORKFLOW_ID, global.id, own.id]);
    expect(repos.workflows.list().map((w) => w.id)).toEqual([STANDARD_WORKFLOW_ID, global.id]);
    expect(repos.workflows.list({ projectId: otherId }).map((w) => w.id)).not.toContain(own.id);

    const saved = repos.workflows.update(own.id, { name: 'Own flow v2', projectId: otherId, graph: graph(['trigger', 'a', 'b']) });
    expect(saved).toMatchObject({ name: 'Own flow v2', version: 2, projectId, description: 'mine', nodeCount: 3 });
    expect(repos.workflows.get(own.id)?.graph.nodes.map((n) => n.id)).toEqual(['trigger', 'a', 'b']);

    expect(repos.workflows.archive(global.id).archived).toBe(true);
    expect(repos.workflows.list({ projectId }).map((w) => w.id)).toEqual([STANDARD_WORKFLOW_ID, own.id]);
    expect(repos.workflows.list({ projectId, includeArchived: true }).map((w) => w.id)).toContain(global.id);
    expect(repos.workflows.get('missing')).toBeNull();
  });

  test('the builtin template is read-only and re-synced from code', () => {
    const { repos } = setup();
    const refusal = (work: () => unknown): number | null => {
      try {
        work();
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowStoreError);
        return (error as WorkflowStoreError).statusCode;
      }
    };
    expect(refusal(() => repos.workflows.update(STANDARD_WORKFLOW_ID, { name: 'x', graph: graph(['t']) }))).toBe(403);
    expect(refusal(() => repos.workflows.archive(STANDARD_WORKFLOW_ID))).toBe(403);
    expect(refusal(() => repos.workflows.update('missing', { name: 'x', graph: graph(['t']) }))).toBe(404);
    expect(refusal(() => repos.workflows.archive('missing'))).toBe(404);

    expect(repos.workflows.ensureBuiltin(STANDARD_WORKFLOW).version).toBe(1);
    expect(repos.workflows.ensureBuiltin({ ...STANDARD_WORKFLOW, name: 'Standard (renamed)' })).toMatchObject({ version: 1, name: 'Standard (renamed)' });
    const changed = repos.workflows.ensureBuiltin({ ...STANDARD_WORKFLOW, graph: graph(['trigger']) });
    expect(changed).toMatchObject({ version: 2, nodeCount: 1, builtin: true });
    expect(repos.workflows.ensureBuiltin({ ...STANDARD_WORKFLOW, graph: graph(['trigger']) }).version).toBe(2);
    expect(repos.workflows.ensureBuiltin({ id: 'wf-new', name: 'New', description: '', graph: graph(['trigger']) }))
      .toMatchObject({ version: 1, builtin: true, projectId: null });
  });
});

describe('fix loop per run', () => {
  test('uses the run-scoped budget, the node round limit and the node fix role', () => {
    const { db, repos, newProject } = setup();
    const ctx = { repos } as unknown as StudioContext;
    const projectId = newProject('fixes');
    const run = createRun(repos, projectId);
    repos.tasks.create(projectId, { runId: run.id, key: 'impl', title: 'Impl', description: '', role: 'backend', kind: 'implement',
      dependsOn: [], orderIndex: 1, maxAttempts: 2, status: 'completed' });
    const qa = repos.tasks.create(projectId, { runId: run.id, nodeId: 'qa', options: { fixRoundsMax: 1, fixRole: 'frontend' }, key: 'qa',
      title: 'QA', description: '', role: 'qa', kind: 'test', dependsOn: ['impl'], orderIndex: 2, maxAttempts: 2, status: 'failed' });

    const round = insertFixTask(ctx, db, qa, 'tests', 'FAIL src/server.test.js')!;
    expect(round.fix).toMatchObject({ key: 'fix-qa-1', role: 'frontend', runId: run.id, nodeId: null, dependsOn: ['impl'], orderIndex: 2 });
    expect(round.requeued).toMatchObject({ status: 'pending', dependsOn: ['fix-qa-1'], orderIndex: 3 });
    expect(fixRoundsUsed(ctx, run.id, 'qa')).toBe(1);
    expect(repos.config.getSetting(`fixRounds:${projectId}:qa`, null)).toBeNull();

    const failedAgain = repos.tasks.update(qa.id, { status: 'failed' });
    expect(insertFixTask(ctx, db, failedAgain, 'tests', 'FAIL again')).toBeNull(); // the node allows one round only
  });
});
