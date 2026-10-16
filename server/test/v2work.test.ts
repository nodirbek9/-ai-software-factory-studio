import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Project, RepoOverview, Run, Task, TaskDetail, TaskDiff, TasksResponse, WorkflowGraph } from '@asf/shared';
import type { Studio } from '../src/app.ts';
import { maxFixRoundsFor } from '../src/orchestrator/fixLoop.ts';
import { git } from '../src/workspace/git.ts';
import { approvePlan, prepareSamples, projectOf, startStudio, taskByKey, tempDir, waitFor } from './helpers.ts';

// Phase 5 read routes (PHASE_5.md): one Scripted sample run, then tasks list/detail/diff and the repo overview.

let studio: Studio;
let project: Project;
let run1: Run;

interface Reply<T> { status: number; body: T }

async function get<T = any>(url: string): Promise<Reply<T>> {
  const res = await studio.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

const task = (key: string): Task => taskByKey(studio, project.id, key)!;
const tasksOf = async (query: string): Promise<TasksResponse> => (await get<TasksResponse>(`/api/v2/tasks?${query}`)).body;
const repo = async (): Promise<RepoOverview> => (await get<RepoOverview>(`/api/v2/projects/${project.id}/repo`)).body;
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Reads until `done` holds or the time is up; returns the last value either way (the caller asserts on it). */
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    value = await read();
  }
  return value;
}

const NOTIFY_GRAPH: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'done', type: 'notify', position: { x: 200, y: 0 }, config: { message: '{{project}} run {{run}}' } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'done' }],
};

beforeAll(async () => {
  // web-ui also writes a .env: the studio never commits it, so it must not reach the task's diff either.
  const samples = prepareSamples((script) => {
    (script.tasks['web-ui'].files as { path: string; content: string }[]).push({ path: '.env', content: 'API_SECRET=from-agent\n' });
  });
  studio = await startStudio(tempDir('v2work'), samples);
  project = await studio.projects.create({ name: 'Work View', spec: '', workspaceMode: 'sample', sampleName: 'todo-service', testCommand: 'npm test' });
  studio.projects.startPlanning(project.id);
  await approvePlan(studio, project.id);
  const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id), 150_000, 'run 1');
  expect(done.status, JSON.stringify(studio.ctx.repos.tasks.listByProject(project.id).map((t) => [t.key, t.status, t.error]))).toBe('completed');
  project = done;
  run1 = studio.ctx.repos.runs.latestForProject(project.id)!;
}, 180_000);

afterAll(async () => { await studio?.close(); });

describe('GET /api/v2/tasks', () => {
  test('lists the current run with project name, run number and duration', async () => {
    const { tasks, truncated } = await tasksOf(`projectId=${project.id}`);
    expect(truncated).toBe(false);
    expect(tasks.map((t) => t.id)).toEqual(studio.ctx.repos.tasks.listByRun(run1.id).map((t) => t.id));
    for (const row of tasks) expect(row).toMatchObject({ projectName: 'Work View', runNumber: 1, runId: run1.id });
    const httpApi = tasks.find((t) => t.key === 'http-api')!;
    expect(httpApi.durationMs).toBe(Date.parse(httpApi.finishedAt!) - Date.parse(httpApi.startedAt!));
    // Without a project filter every project's current run is listed.
    expect((await tasksOf('')).tasks.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
  });

  test('filters by role, status and text (case-insensitive key/title/description)', async () => {
    const backend = (await tasksOf(`projectId=${project.id}&role=backend`)).tasks;
    expect(backend.map((t) => t.key).sort()).toEqual(['http-api', 'todo-store']);
    const completed = studio.ctx.repos.tasks.listByRun(run1.id).filter((t) => t.status === 'completed').map((t) => t.id);
    expect(completed.length).toBeGreaterThan(5);
    expect((await tasksOf(`projectId=${project.id}&status=completed`)).tasks.map((t) => t.id)).toEqual(completed);
    expect((await tasksOf(`projectId=${project.id}&status=failed`)).tasks).toEqual([]);
    expect((await tasksOf(`projectId=${project.id}&q=REST%20api`)).tasks.map((t) => t.key)).toEqual(['http-api']); // title
    expect((await tasksOf(`projectId=${project.id}&q=ESCAPE%20USER`)).tasks.map((t) => t.key)).toEqual(['web-ui']); // description
    expect((await tasksOf(`projectId=${project.id}&q=todo-st`)).tasks.map((t) => t.key)).toEqual(['todo-store']); // key
    const limited = await tasksOf(`projectId=${project.id}&limit=2`);
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.tasks).toHaveLength(2);
  });

  test('rejects bad queries and unknown projects or runs', async () => {
    expect((await get(`/api/v2/tasks?status=done`)).status).toBe(400);
    expect((await get(`/api/v2/tasks?limit=5000`)).status).toBe(400);
    expect((await get(`/api/v2/tasks?projectId=${randomUUID()}`)).status).toBe(404);
    expect((await get(`/api/v2/tasks?runId=${randomUUID()}`)).status).toBe(404);
  });
});

describe('GET /api/v2/tasks/:id', () => {
  test('a verification task has fix rounds; a review task has its review text; events are the task\'s, oldest first', async () => {
    const qa = await get<TaskDetail>(`/api/v2/tasks/${task('api-tests').id}`);
    expect(qa.status).toBe(200);
    expect(qa.body.fixRounds).toEqual({ used: 0, max: maxFixRoundsFor(studio.ctx, task('api-tests')) });
    expect(qa.body.reviewText).toBeNull();
    expect(qa.body.run).toMatchObject({ id: run1.id, number: 1 });
    expect(qa.body.events.length).toBeGreaterThan(0);
    expect(qa.body.events.every((e) => e.taskId === task('api-tests').id)).toBe(true);
    const ids = qa.body.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(qa.body.events.some((e) => e.type === 'test.result')).toBe(true);

    const review = (await get<TaskDetail>(`/api/v2/tasks/${task('security-review').id}`)).body;
    expect(review.fixRounds).toEqual({ used: 0, max: maxFixRoundsFor(studio.ctx, task('security-review')) });
    expect(review.reviewText).toContain('VERDICT: PASS');

    const impl = (await get<TaskDetail>(`/api/v2/tasks/${task('http-api').id}`)).body;
    expect(impl).toMatchObject({ fixRounds: null, reviewText: null });
    expect(impl.task).toMatchObject({ key: 'http-api', projectName: 'Work View', runNumber: 1, attempt: 2 });
    expect((await get(`/api/v2/tasks/${randomUUID()}`)).status).toBe(404);
  });
});

describe('GET /api/v2/tasks/:id/diff', () => {
  test('an implement task\'s diff equals git diff of its range and lists only its own files', async () => {
    const httpApi = task('http-api');
    const { status, body } = await get<TaskDiff>(`/api/v2/tasks/${httpApi.id}/diff`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ taskId: httpApi.id, truncated: false, note: null });
    expect(body.head).toBe(await git(project.workspacePath, ['rev-parse', `refs/heads/${httpApi.branch}`]));
    expect(body.diff).toBe(await git(project.workspacePath, ['diff', `${body.base}..${body.head}`]));
    // Only this task's change: todo-store was merged before http-api started, so it is not part of the diff.
    expect(body.files).toEqual(['src/server.js']);
    expect(body.files).toEqual(httpApi.filesChanged);
    expect(body.diff).toContain('+++ b/src/server.js');
    expect(body.diff).not.toContain('src/todoStore.js');
  });

  test('a file the agent wrote to .env is never part of the diff', async () => {
    const webUi = task('web-ui');
    const body = (await get<TaskDiff>(`/api/v2/tasks/${webUi.id}/diff`)).body;
    expect(body.files).toEqual(['public/app.js', 'public/index.html']);
    expect(body.diff).not.toContain('API_SECRET');
    expect(body.diff).toBe(await git(project.workspacePath, ['diff', `${body.base}..${body.head}`]));
  });

  test('tasks without a branch of their own get an empty diff with a note', async () => {
    const body = (await get<TaskDiff>(`/api/v2/tasks/${task('architecture').id}/diff`)).body;
    expect(body).toMatchObject({ base: null, head: null, files: [], diff: '', truncated: false });
    expect(body.note).toMatch(/branch/);
  });
});

describe('GET /api/v2/projects/:id/repo', () => {
  test('lists the integration branch, task branches with ahead/behind and owners, and no leftover worktrees', async () => {
    const cwd = project.workspacePath;
    const overview = await repo();
    expect(overview.error).toBeNull();
    expect(overview).toMatchObject({ projectId: project.id, integrationBranch: 'asf/work-view/integration', baseCommit: project.baseCommit,
      wipCommits: [], conflicts: [] });
    expect(overview.integrationHead).toBe(await git(cwd, ['rev-parse', 'refs/heads/asf/work-view/integration']));
    expect(overview.branches[0]).toMatchObject({ name: 'asf/work-view/integration', kind: 'integration', ahead: null, behind: null, owner: null });

    const byName = new Map(overview.branches.map((b) => [b.name, b]));
    const integrationOnly = (await git(cwd, ['log', '--format=%H', 'main..asf/work-view/integration'])).split('\n').filter(Boolean).length;
    expect(byName.get('main')).toMatchObject({ kind: 'other', ahead: 0, behind: integrationOnly, owner: null });
    const httpApi = task('http-api');
    const merged = byName.get(httpApi.branch!)!;
    expect(merged).toMatchObject({ kind: 'task', ahead: 0, head: await git(cwd, ['rev-parse', `refs/heads/${httpApi.branch}`]),
      lastCommitSubject: 'feat(http-api): HTTP REST API and static hosting' });
    expect(merged.behind).toBeGreaterThan(0);
    expect(merged.owner).toEqual({ type: 'task', id: httpApi.id, title: httpApi.title, status: 'completed' });
    expect(Date.parse(merged.lastCommitAt!)).not.toBeNaN();
    // The failed first attempt's branch (no commits) still belongs to the task.
    expect(byName.get('asf/work-view/http-api-a1')).toMatchObject({ kind: 'task', ahead: 0, owner: { type: 'task', id: httpApi.id } });

    // Task worktrees are removed after their merge; only the user's checkout and the integration worktree stay.
    const settled = await poll(async () => (await repo()).worktrees, (list) => list.length === 2, 30_000);
    expect(settled.map((w) => w.path), JSON.stringify(settled)).toHaveLength(2);
    expect(settled.some((w) => samePath(w.path, cwd) && w.branch === 'main')).toBe(true);
    const integration = settled.find((w) => samePath(w.path, project.integrationPath!))!;
    expect(integration).toMatchObject({ branch: 'asf/work-view/integration', head: overview.integrationHead, owner: null });
    expect(Date.parse(integration.modifiedAt!)).not.toBeNaN();
  });

  test('a committed secret is omitted from the diff with a note; wip commits make a partial branch', async () => {
    const cwd = project.workspacePath;
    const webUi = task('web-ui');
    // Test-only setup: a commit with a .env on the task branch (the studio itself never commits secrets).
    const scratch = path.join(tempDir('v2work-wt'), 'wt');
    await git(cwd, ['worktree', 'add', scratch, webUi.branch!]);
    fs.writeFileSync(path.join(scratch, '.env'), 'API_SECRET=committed\n');
    fs.writeFileSync(path.join(scratch, 'public', 'extra.txt'), 'extra\n');
    await git(scratch, ['add', '.env', 'public/extra.txt']);
    await git(scratch, ['commit', '-q', '-m', 'wip(web-ui): partial work from interrupted attempt 1']);
    await git(cwd, ['worktree', 'remove', '--force', scratch]);

    const body = (await get<TaskDiff>(`/api/v2/tasks/${webUi.id}/diff`)).body;
    expect(body.note).toMatch(/Omitted 1 sensitive file/);
    expect(body.files).toEqual(['public/app.js', 'public/extra.txt', 'public/index.html']);
    expect(body.diff).not.toContain('API_SECRET');
    expect(body.diff).toBe(await git(cwd, ['diff', `${body.base}..${body.head}`, '--', '.', ':(exclude,literal).env']));

    const overview = await repo();
    const branch = overview.branches.find((b) => b.name === webUi.branch)!;
    expect(branch).toMatchObject({ kind: 'partial', ahead: 1, owner: { type: 'task', id: webUi.id } });
    expect(overview.wipCommits).toEqual([expect.objectContaining({ branch: webUi.branch, sha: branch.head,
      subject: 'wip(web-ui): partial work from interrupted attempt 1' })]);
  });

  test('answers with an error (not a failure) when the workspace is gone or not a repository; 404 for unknown projects', async () => {
    const make = (name: string, workspacePath: string): Project => studio.ctx.repos.projects.create({ name, slug: name.toLowerCase(),
      description: '', spec: 'spec', workspaceMode: 'new', workspacePath, testCommand: '' });
    const removedDir = tempDir('v2work-gone');
    const removed = make('Gone', removedDir);
    fs.rmSync(removedDir, { recursive: true, force: true });
    const gone = await get<RepoOverview>(`/api/v2/projects/${removed.id}/repo`);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ branches: [], worktrees: [], wipCommits: [], integrationHead: null });
    expect(gone.body.error).toMatch(/missing/);

    const plain = make('Plain', tempDir('v2work-plain'));
    expect((await get<RepoOverview>(`/api/v2/projects/${plain.id}/repo`)).body.error).toMatch(/not a git repository/);
    expect((await get(`/api/v2/projects/${randomUUID()}/repo`)).status).toBe(404);
    expect((await get('/api/v2/projects/not-a-uuid/repo')).status).toBe(400);
  });
});

describe('run scopes', () => {
  test('after a second run, "active" lists it, "all" lists both (newest run first) and a run id lists one run', async () => {
    const workflow = studio.ctx.repos.workflows.create({ name: 'Notify only', projectId: project.id, graph: NOTIFY_GRAPH });
    const run2 = studio.runs.start(project.id, workflow.id);
    await waitFor(() => studio.ctx.repos.runs.get(run2.id)?.finishedAt, 60_000, 'run 2');
    const run1Ids = studio.ctx.repos.tasks.listByRun(run1.id).map((t) => t.id);

    const active = (await tasksOf(`projectId=${project.id}`)).tasks;
    expect(active.map((t) => [t.key, t.runNumber])).toEqual([['done', 2]]);
    const all = (await tasksOf(`projectId=${project.id}&runId=all`)).tasks;
    expect(all).toHaveLength(run1Ids.length + 1);
    expect(all[0]).toMatchObject({ key: 'done', runNumber: 2 });
    expect(all.slice(1).map((t) => t.id)).toEqual(run1Ids);
    expect((await tasksOf(`runId=${run1.id}`)).tasks.map((t) => t.id)).toEqual(run1Ids);
    const other = studio.ctx.repos.projects.list().find((p) => p.id !== project.id)!;
    expect((await tasksOf(`runId=${run1.id}&projectId=${other.id}`)).tasks).toEqual([]);
  });
});
