import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createStudio, type Studio } from '../src/app.ts';
import { ProviderError, type ProviderAdapter, type ProviderRunRequest } from '../src/providers/types.ts';
import { prepareSamples, projectOf, taskByKey, tempDir, waitFor, approvePlan } from './helpers.ts';

let studios: Studio[] = [];
afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

async function studioWith(...adapters: ProviderAdapter[]): Promise<Studio> {
  const dataDir = tempDir('resil');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
    { extraProviders: adapters });
  studios.push(studio);
  for (const adapter of adapters) studio.ctx.registry.updateProvider(adapter.id, { enabled: true });
  return studio;
}

const base = { kind: 'builtin' as const, editsFiles: true, isAi: true, reportsActivity: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }) };

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new ProviderError('aborted', false)), { once: true }));

describe('idle watchdog', () => {
  test('stops a silent agent but lets a busy one finish', async () => {
    const silent: ProviderAdapter = { ...base, id: 'silent', label: 'Silent', run: (r: ProviderRunRequest) => waitForAbort(r.signal) };
    const busy: ProviderAdapter = { ...base, id: 'busy', label: 'Busy', run: async (r) => {
      for (let i = 0; i < 10; i += 1) { await new Promise((ok) => setTimeout(ok, 100)); r.onHeartbeat?.(); }
      return { text: 'done after 1s', usage: null };
    } };
    const studio = await studioWith(silent, busy);
    const project = await studio.projects.create({ name: 'Idle', spec: 'x', workspaceMode: 'new' });
    studio.ctx.repos.config.upsertAgentConfig({ role: 'pm', providerId: 'silent', model: 'm', allowFallback: false, effort: '' });
    const run = (idleTimeoutMs: number) => studio.ctx.executor.run({ project, task: null, role: 'pm', prompt: () => 'hi', cwd: project.workspacePath,
      mode: 'readonly', signal: new AbortController().signal, timeoutMs: 60_000, idleTimeoutMs, fallbackOrder: [] });
    await expect(run(300)).rejects.toThrow(/no activity for/);

    studio.ctx.repos.config.upsertAgentConfig({ role: 'pm', providerId: 'busy', model: 'm', allowFallback: false, effort: '' });
    await expect(run(300)).resolves.toMatchObject({ text: 'done after 1s' });
  });
});

describe('interrupted attempts keep their work', () => {
  test('the next attempt starts from the partial work of the interrupted one', async () => {
    const seen: string[] = [];
    const agent: ProviderAdapter = { ...base, id: 'resumer', label: 'Resumer', run: async (r) => {
      const kind = r.task?.kind;
      if (kind === 'plan') return { text: JSON.stringify({ tasks: [{ key: 'build', title: 'Build it', role: 'backend', dependsOn: [] },
        { key: 'check', title: 'Tests', role: 'qa', dependsOn: ['build'] }] }), usage: null };
      if (kind === 'architecture') return { text: '# Plan\n\nBuild part one and part two, then test them.', usage: null };
      if (kind === 'security' || kind === 'review') return { text: 'Looks fine.\nVERDICT: PASS', usage: null };
      if (kind === 'test') {
        fs.mkdirSync(path.join(r.cwd, 'test'), { recursive: true });
        fs.writeFileSync(path.join(r.cwd, 'test', 'ok.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
        return { text: 'tests added', usage: null };
      }
      // implement: attempt 1 writes half the work and is interrupted; attempt 2 must see that work.
      if (r.task?.attempt === 1) {
        fs.writeFileSync(path.join(r.cwd, 'part1.txt'), 'first half');
        throw new ProviderError('connection dropped mid-run');
      }
      seen.push(fs.existsSync(path.join(r.cwd, 'part1.txt')) ? 'resumed-with-part1' : 'started-empty');
      seen.push(r.prompt.includes('previous attempt') ? 'prompt-says-resume' : 'prompt-plain');
      fs.writeFileSync(path.join(r.cwd, 'part2.txt'), 'second half');
      return { text: 'finished', usage: null };
    } };
    const studio = await studioWith(agent);
    for (const role of ['pm', 'architect', 'backend', 'qa', 'security', 'reviewer'] as const) {
      studio.ctx.repos.config.upsertAgentConfig({ role, providerId: 'resumer', model: 'm', allowFallback: false, effort: '' });
    }
    const project = await studio.projects.create({ name: 'Resume', spec: 'Build two parts', workspaceMode: 'new', testCommand: 'node --test' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 60_000, 'project end');

    const build = taskByKey(studio, project.id, 'build')!;
    expect(build.status, build.error ?? '').toBe('completed');
    expect(build.attempt).toBe(2);
    expect(seen).toEqual(['resumed-with-part1', 'prompt-says-resume']);
    const root = projectOf(studio, project.id).integrationPath!;
    expect(fs.readFileSync(path.join(root, 'part1.txt'), 'utf8')).toBe('first half');
    expect(fs.readFileSync(path.join(root, 'part2.txt'), 'utf8')).toBe('second half');
    expect(studio.ctx.repos.events.list({ projectId: project.id, limit: 2000 }).some((e) => e.type === 'task.partial')).toBe(true);
  });
});

describe('parallel agents editing the same file', () => {
  test('a merge conflict is resolved by the agent instead of failing the task', async () => {
    let resolverCalls = 0;
    const agent: ProviderAdapter = { ...base, id: 'parallel', label: 'Parallel', run: async (r) => {
      const kind = r.task?.kind;
      if (kind === 'plan') return { text: JSON.stringify({ tasks: [
        { key: 'api-a', title: 'Endpoint A', role: 'backend', dependsOn: [] },
        { key: 'api-b', title: 'Endpoint B', role: 'backend', dependsOn: [] },
        { key: 'check', title: 'Tests', role: 'qa', dependsOn: ['api-a', 'api-b'] }] }), usage: null };
      if (kind === 'architecture') return { text: '# Plan\n\nTwo endpoints documented in docs/API.md, then tests.', usage: null };
      if (kind === 'security' || kind === 'review') return { text: 'ok\nVERDICT: PASS', usage: null };
      const api = path.join(r.cwd, 'docs', 'API.md');
      if (r.prompt.includes('conflict markers')) {
        resolverCalls += 1;
        const merged = fs.readFileSync(api, 'utf8').split(/\r?\n/).filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n');
        fs.writeFileSync(api, merged);
        return { text: 'kept both endpoints', usage: null };
      }
      if (kind === 'test') {
        fs.mkdirSync(path.join(r.cwd, 'test'), { recursive: true });
        fs.writeFileSync(path.join(r.cwd, 'test', 'ok.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
        return { text: 'tests', usage: null };
      }
      // Both endpoint tasks append their own section at the same place -> guaranteed conflict for the second merge.
      const which = r.task?.key === 'api-a' ? 'A' : 'B';
      await new Promise((ok) => setTimeout(ok, which === 'A' ? 50 : 600));
      fs.mkdirSync(path.dirname(api), { recursive: true });
      fs.writeFileSync(api, `# API\n\n## Endpoint ${which}\nGET /${which.toLowerCase()}\n`);
      return { text: `endpoint ${which}`, usage: null };
    } };
    const studio = await studioWith(agent);
    for (const role of ['pm', 'architect', 'backend', 'qa', 'security', 'reviewer'] as const) {
      studio.ctx.repos.config.upsertAgentConfig({ role, providerId: 'parallel', model: 'm', allowFallback: false, effort: '' });
    }
    const project = await studio.projects.create({ name: 'Conflicts', spec: 'Two endpoints', workspaceMode: 'new', testCommand: 'node --test' });
    studio.projects.startPlanning(project.id);
    await approvePlan(studio, project.id);
    await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 60_000, 'project end');

    const tasks = studio.ctx.repos.tasks.listByProject(project.id);
    expect(projectOf(studio, project.id).status, JSON.stringify(tasks.map((t) => [t.key, t.status, t.error]))).toBe('completed');
    expect(resolverCalls).toBe(1);
    const api = fs.readFileSync(path.join(projectOf(studio, project.id).integrationPath!, 'docs', 'API.md'), 'utf8');
    expect(api).toContain('Endpoint A');
    expect(api).toContain('Endpoint B');
    expect(api).not.toMatch(/<{7}|>{7}/);
    expect(studio.ctx.repos.events.list({ projectId: project.id, limit: 2000 }).some((e) => e.type === 'git.conflict')).toBe(true);
  });
});

describe('conflict markers never reach the integration branch', () => {
  test('leftover markers on a task branch are resolved before merging', async () => {
    let resolverCalls = 0;
    const agent: ProviderAdapter = { ...base, id: 'markers', label: 'Markers', run: async (r) => {
      const kind = r.task?.kind;
      if (kind === 'plan') return { text: JSON.stringify({ tasks: [{ key: 'docs', title: 'Docs', role: 'backend', dependsOn: [] },
        { key: 'check', title: 'Tests', role: 'qa', dependsOn: ['docs'] }] }), usage: null };
      if (kind === 'architecture') return { text: '# Plan\n\nWrite the API documentation first, then add automated tests.', usage: null };
      if (kind === 'security' || kind === 'review') return { text: 'ok\nVERDICT: PASS', usage: null };
      const doc = path.join(r.cwd, 'docs', 'API.md');
      if (r.prompt.includes('conflict markers')) {
        resolverCalls += 1;
        fs.writeFileSync(doc, '# API\n\nGET /a\nGET /b\n');
        return { text: 'merged', usage: null };
      }
      if (kind === 'test') {
        fs.mkdirSync(path.join(r.cwd, 'test'), { recursive: true });
        fs.writeFileSync(path.join(r.cwd, 'test', 'ok.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
        return { text: 'tests', usage: null };
      }
      fs.mkdirSync(path.dirname(doc), { recursive: true });
      fs.writeFileSync(doc, '# API\n\n<<<<<<< HEAD\nGET /a\n=======\nGET /b\n>>>>>>> other\n');
      return { text: 'docs with a leftover conflict', usage: null };
    } };
    const studio = await studioWith(agent);
    for (const role of ['pm', 'architect', 'backend', 'qa', 'security', 'reviewer'] as const) {
      studio.ctx.repos.config.upsertAgentConfig({ role, providerId: 'markers', model: 'm', allowFallback: false, effort: '' });
    }
    const project = await studio.projects.create({ name: 'Markers', spec: 'Docs', workspaceMode: 'new', testCommand: 'node --test' });
    studio.projects.startPlanning(project.id);
    await waitFor(() => projectOf(studio, project.id).status !== 'planning', 20_000, 'planning end').catch(() => undefined);
    if (projectOf(studio, project.id).status === 'failed') throw new Error(JSON.stringify(studio.ctx.repos.tasks.listByProject(project.id).map((t) => [t.key, t.status, t.error])));
    await approvePlan(studio, project.id);
    await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 60_000, 'project end');
    expect(projectOf(studio, project.id).status).toBe('completed');
    expect(resolverCalls).toBe(1);
    const api = fs.readFileSync(path.join(projectOf(studio, project.id).integrationPath!, 'docs', 'API.md'), 'utf8');
    expect(api).not.toMatch(/<{7}|>{7}|={7}/);
  });
});
