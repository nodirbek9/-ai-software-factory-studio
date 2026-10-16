import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Studio } from '../src/app.ts';
import { fixRoundsUsed } from '../src/orchestrator/fixLoop.ts';
import { git } from '../src/workspace/git.ts';
import { approvePlan, prepareSamples, projectOf, startStudio, taskByKey, tempDir, waitFor } from './helpers.ts';

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

describe('end-to-end workflow with the sample project', () => {
  test('plans, waits for approval, implements, retries, tests, reviews and reports', async () => {
    const studio = await open(tempDir('e2e'), prepareSamples());
    const project = await studio.projects.create({ name: 'Todo E2E', spec: '', workspaceMode: 'sample', sampleName: 'todo-service', testCommand: 'npm test' });
    expect(project.integrationBranch).toBe('asf/todo-e2e/integration');
    expect(project.spec).toContain('Todo Service');

    studio.projects.startPlanning(project.id);
    await waitFor(() => projectOf(studio, project.id).status === 'awaiting_approval', 60_000, 'awaiting_approval');
    // Nothing is implemented before approval.
    expect(taskByKey(studio, project.id, 'todo-store')?.status).toBe('pending');
    expect(projectOf(studio, project.id).planMarkdown).toContain('Implementation plan');

    await approvePlan(studio, project.id);
    const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id), 120_000, 'completion');
    const tasks = studio.ctx.repos.tasks.listByProject(project.id);
    expect(done.status, JSON.stringify(tasks.map((t) => [t.key, t.status, t.error]))).toBe('completed');

    const httpApi = taskByKey(studio, project.id, 'http-api')!;
    expect(httpApi.attempt).toBe(2); // scripted failure on attempt 1, retried automatically
    expect(httpApi.filesChanged).toContain('src/server.js');

    const qa = taskByKey(studio, project.id, 'api-tests')!;
    expect(qa.testResult?.passed).toBe(true);
    expect(qa.testResult?.summary).toMatch(/6 passed, 0 failed/);

    expect(taskByKey(studio, project.id, 'security-review')?.resultSummary).toContain('VERDICT: PASS');
    const final = projectOf(studio, project.id);
    expect(final.reportMarkdown).toContain('Delivery report');
    expect(final.reportMarkdown).toContain('not AI');
    expect(fs.existsSync(path.join(final.integrationPath!, 'ASF_REPORT.md'))).toBe(true);

    // The user's own branch is untouched; work lives on the integration branch.
    const mainLog = await git(final.workspacePath, ['log', '--oneline', 'main']);
    expect(mainLog.split('\n')).toHaveLength(1);
    const integrationLog = await git(final.integrationPath!, ['log', '--oneline']);
    expect(integrationLog).toContain('merge http-api');

    // Task worktrees are cleaned up after merge.
    // (Windows may delay directory deletion; the manager retries in the background.)
    const leftovers = () => fs.readdirSync(path.dirname(final.integrationPath!)).filter((d) => d !== 'integration');
    await waitFor(() => leftovers().length === 0, 30_000, `worktree cleanup (${leftovers().join(', ')})`);

    const types = new Set(studio.ctx.repos.events.list({ projectId: project.id, limit: 2000 }).map((e) => e.type));
    for (const type of ['task.updated', 'agent.started', 'git.merge', 'test.result', 'approval.updated', 'provider.fallback']) expect(types).toContain(type);
  });

  test('fix loop: red tests get a Backend fix task, then the tests run again and pass', async () => {
    const samples = prepareSamples((script) => {
      const store = script.tasks['todo-store'].files[0] as { path: string; content: string };
      script.tasks['fix-api-tests-1'] = { delayMs: 200, summary: 'Restored the 200-character title limit.', files: [{ ...store }] };
      store.content = store.content.replace('const MAX_TITLE = 200;', 'const MAX_TITLE = 20;');
    });
    const studio = await open(tempDir('fix'), samples);
    const project = await studio.projects.create({ name: 'Fixable', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    const done = await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status) && projectOf(studio, project.id), 120_000, 'completion');
    const tasks = studio.ctx.repos.tasks.listByProject(project.id);
    expect(done.status, JSON.stringify(tasks.map((t) => [t.key, t.status, t.error]))).toBe('completed');

    const fix = taskByKey(studio, project.id, 'fix-api-tests-1')!;
    expect(fix).toMatchObject({ role: 'backend', kind: 'implement', status: 'completed', dependsOn: ['http-api', 'web-ui'] });
    expect(fix.description).toMatch(/Fix round 1/);
    expect(fix.description).toMatch(/at most 20 characters/); // the red test output reached the fix agent
    expect(fix.filesChanged).toContain('src/todoStore.js');

    const qa = taskByKey(studio, project.id, 'api-tests')!;
    expect(qa.dependsOn).toEqual(['fix-api-tests-1']);
    expect(qa.attempt).toBe(2); // red on attempt 1, green after the fix
    expect(qa.testResult?.passed).toBe(true);
    expect(qa.resultSummary).toMatch(/Re-ran the existing tests after the fix/); // QA wrote no new tests on the re-run
    expect(fix.orderIndex).toBeLessThan(qa.orderIndex); // inserted before the failed verification
    expect(fixRoundsUsed(studio.ctx, qa.runId, 'api-tests')).toBe(1);
    expect(fix.runId).toBe(qa.runId);
    expect(await git(done.integrationPath!, ['log', '--oneline'])).toContain('merge fix-api-tests-1');
  });

  test('fix rounds are limited; then the task stays failed, blocks dependants and can be retried by hand', async () => {
    const samples = prepareSamples((script) => {
      const files = script.tasks['api-tests'].files as { path: string; content: string }[];
      files[0].content = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n";
      script.tasks['fix-api-tests-1'] = { delayMs: 200, summary: 'Attempted a fix.', files: [{ path: 'docs/fix-notes.md', content: 'tried\n' }] };
    });
    const studio = await open(tempDir('fail'), samples);
    studio.ctx.repos.config.setSetting('studio', { maxFixRounds: 1 });
    const project = await studio.projects.create({ name: 'Broken', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => projectOf(studio, project.id).status === 'failed', 120_000, 'failed project');

    expect(taskByKey(studio, project.id, 'fix-api-tests-1')?.status).toBe('completed');
    expect(taskByKey(studio, project.id, 'fix-api-tests-2')).toBeUndefined();
    const qa = taskByKey(studio, project.id, 'api-tests')!;
    expect(qa.status).toBe('failed');
    expect(qa.attempt).toBe(2);
    expect(qa.testResult?.passed).toBe(false);
    expect(qa.testResult?.summary).toMatch(/1 failed/);
    expect(taskByKey(studio, project.id, 'security-review')?.status).toBe('blocked');
    expect(taskByKey(studio, project.id, 'delivery-report')?.status).toBe('blocked');
    const events = studio.ctx.repos.events.list({ projectId: project.id, limit: 2000 });
    expect(events.some((e) => e.type === 'task.fix_exhausted')).toBe(true);

    studio.scheduler.retryTask(qa.id);
    expect(taskByKey(studio, project.id, 'security-review')?.status).toBe('pending');
    await waitFor(() => taskByKey(studio, project.id, 'api-tests')!.attempt === 3 && taskByKey(studio, project.id, 'api-tests')!.status === 'failed', 60_000, 'retry');
    expect(fixRoundsUsed(studio.ctx, qa.runId, 'api-tests')).toBe(1);
  });

  test('fix loop: a FAIL review verdict sends the findings to a fix task and the review runs again', async () => {
    const samples = prepareSamples((script) => {
      script.tasks['security-review'].text = '## Security review\n\n- HIGH: `src/server.js` echoes raw errors to clients.\n\nVERDICT: FAIL';
      script.tasks['fix-security-review-1'] = { delayMs: 200, summary: 'Hid internal errors.', files: [{ path: 'docs/security-fix.md', content: 'fixed\n' }] };
    });
    const studio = await open(tempDir('review-fix'), samples);
    studio.ctx.repos.config.setSetting('studio', { maxFixRounds: 1 });
    const project = await studio.projects.create({ name: 'Insecure', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => projectOf(studio, project.id).status === 'failed', 120_000, 'failed project');

    const fix = taskByKey(studio, project.id, 'fix-security-review-1')!;
    expect(fix).toMatchObject({ role: 'backend', kind: 'implement', status: 'completed', dependsOn: ['api-tests'] });
    expect(fix.description).toContain('HIGH: `src/server.js` echoes raw errors');
    const review = taskByKey(studio, project.id, 'security-review')!;
    expect(review.dependsOn).toEqual(['fix-security-review-1']);
    expect(review.attempt).toBe(2); // re-reviewed once after the fix, still FAIL, no rounds left
    expect(review.testResult?.passed).toBe(true); // the tests ran again after the fix, before the re-review
    expect(review.status).toBe('failed');
    expect(taskByKey(studio, project.id, 'final-review')?.status).toBe('blocked');
  });

  test('pause lets running work finish but starts nothing new; resume continues', async () => {
    const samples = prepareSamples((script) => { script.tasks['todo-store'].delayMs = 1500; script.tasks['web-ui'].delayMs = 1500; });
    const studio = await open(tempDir('pause'), samples);
    const project = await studio.projects.create({ name: 'Pausable', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => taskByKey(studio, project.id, 'todo-store')?.status === 'running', 30_000, 'todo-store running');
    studio.scheduler.pause(project.id);

    await waitFor(() => taskByKey(studio, project.id, 'todo-store')?.status === 'completed', 30_000, 'drain');
    await new Promise((r) => setTimeout(r, 800));
    expect(projectOf(studio, project.id).status).toBe('paused');
    expect(['pending', 'ready']).toContain(taskByKey(studio, project.id, 'http-api')?.status);
    expect(taskByKey(studio, project.id, 'http-api')?.attempt).toBe(0);
    expect(studio.scheduler.runningCount).toBe(0);

    studio.scheduler.resume(project.id);
    await waitFor(() => projectOf(studio, project.id).status === 'completed', 120_000, 'completion after resume');
  });

  test('recovers tasks interrupted by a crash from their checkpoint', async () => {
    const dataDir = tempDir('recover');
    const samples = prepareSamples();
    const first = await open(dataDir, samples);
    const project = await first.projects.create({ name: 'Crashy', spec: '', workspaceMode: 'sample', sampleName: 'todo-service' });
    first.projects.startPlanning(project.id);
    await first.close();
    studios = [];

    // Simulate a hard crash in the middle of the plan task.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(dataDir, 'studio.db'));
    raw.prepare(`UPDATE tasks SET status = 'running', checkpoint = 'agent_done', attempt = 1 WHERE project_id = ? AND key = 'plan'`).run(project.id);
    raw.prepare(`UPDATE projects SET status = 'planning' WHERE id = ?`).run(project.id);
    raw.close();

    const second = await open(dataDir, samples);
    const events = () => second.ctx.repos.events.list({ projectId: project.id, limit: 2000 });
    expect(events().some((e) => e.message.includes('interrupted at checkpoint "agent_done"'))).toBe(true);
    await waitFor(() => projectOf(second, project.id).status === 'awaiting_approval', 60_000, 'planning after recovery');
    expect(taskByKey(second, project.id, 'plan')?.attempt).toBe(2);
  });

  test('a real-AI-only project fails clearly when no AI provider is usable', async () => {
    const studio = await open(tempDir('noai'), prepareSamples());
    const project = await studio.projects.create({ name: 'Real spec', spec: '# Build a CLI\nSomething real.', workspaceMode: 'new' });
    studio.projects.startPlanning(project.id);
    await waitFor(() => projectOf(studio, project.id).status === 'failed', 30_000, 'failure');
    const plan = taskByKey(studio, project.id, 'plan')!;
    expect(plan.error).toMatch(/Scripted provider needs \.asf-script\.json/);
    expect(plan.attempt).toBe(1); // permanent error: no pointless retries
  });
});
