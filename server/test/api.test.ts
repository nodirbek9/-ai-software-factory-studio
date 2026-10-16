import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { ProviderLimitError } from '../src/providers/types.ts';
import { createStudio, type Studio } from '../src/app.ts';
import { prepareSamples, tempDir } from './helpers.ts';

const studios: Studio[] = [];
afterAll(async () => { for (const s of studios) await s.close(); });

async function studioWith(authToken: string | null): Promise<Studio> {
  const dataDir = tempDir('api');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken, approvedRoots: [] });
  studios.push(studio);
  return studio;
}

describe('HTTP API', () => {
  test('tests the saved offline provider and validates roles', async () => {
    const { app, ctx } = await studioWith(null);
    ctx.repos.config.upsertAgentConfig({ role: 'pm', providerId: 'scripted', model: '', effort: 'high', allowFallback: true });
    const response = await app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: 'pm', providerId: 'scripted', requestedModel: 'replay',
      ok: false, answer: null, correct: null, effortApplied: false });
    expect(response.json().error).toMatch(/cannot do real AI work/);
    expect((await app.inject({ method: 'POST', url: '/api/agents/unknown/test', payload: {} })).statusCode).toBe(400);
    ctx.registry.updateProvider('scripted', { enabled: false });
    const disabled = await app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ ok: false, providerId: 'scripted' });
    expect(disabled.json().error).toMatch(/disabled/);
  });

  test('returns measured output, passes saved settings and records usage', async () => {
    const { app, ctx } = await studioWith(null);
    ctx.repos.config.upsertAgentConfig({ role: 'pm', providerId: 'scripted', model: 'asked', effort: 'high', allowFallback: true });
    ctx.registry.updateProvider('scripted', { settings: { models: 'asked' } });
    const run = vi.spyOn(ctx.registry.get('scripted')!, 'run').mockResolvedValue({ text: ' 1591 \n', model: 'actual',
      usage: { inputTokens: 2, outputTokens: 133, reasoningTokens: 129, costUsd: 0 } });
    const response = await app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} });
    expect(response.json()).toMatchObject({ ok: true, answer: '1591', correct: true, requestedModel: 'asked',
      actualModel: 'actual', reasoningTokens: 129, outputTokens: 133, effortApplied: false });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readonly', model: 'asked', effort: 'high',
      timeoutMs: 180_000, cwd: path.join(ctx.config.dataDir, 'agent-test'),
      prompt: 'What is 37 * 43? Think it through, then reply with only the number.' }), { models: 'asked' });
    expect(ctx.repos.usage.sinceByProvider('2000-01-01').get('scripted')?.calls).toBe(1);
    expect(ctx.repos.events.list({}).some((event) => event.type === 'agent.test' && event.role === 'pm')).toBe(true);
    run.mockRestore();
  });

  test('rejects overlapping tests, parks limited providers and releases the role', async () => {
    const { app, ctx } = await studioWith(null);
    ctx.repos.config.upsertAgentConfig({ role: 'pm', providerId: 'scripted', model: '', effort: '', allowFallback: true });
    let fail!: (error: Error) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const run = vi.spyOn(ctx.registry.get('scripted')!, 'run').mockImplementation(() => {
      started();
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    const pending = app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} }).then((response) => response);
    await ready;
    expect((await app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} })).statusCode).toBe(409);
    fail(new ProviderLimitError('usage limit ' + 'x'.repeat(600), new Date(Date.now() + 60_000)));
    const response = await pending;
    expect(response.json().ok).toBe(false);
    expect(response.json().error).toHaveLength(500);
    expect(ctx.registry.limitedUntil('scripted')).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/agents/pm/test', payload: {} })).statusCode).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  test('creates a sample project and returns a snapshot with seven agents', async () => {
    const { app } = await studioWith(null);
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Api sample', workspaceMode: 'sample', sampleName: 'todo-service' } });
    expect(created.statusCode).toBe(201);
    const snapshot = (await app.inject({ url: `/api/projects/${created.json().id}` })).json();
    expect(snapshot.project.status).toBe('draft');
    expect(snapshot.agents).toHaveLength(7);
  });

  test('validates input and never exposes provider secrets', async () => {
    const { app } = await studioWith(null);
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } })).statusCode).toBe(400);
    const patched = await app.inject({ method: 'PATCH', url: '/api/providers/openai-compatible',
      payload: { settings: { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-should-not-be-stored-1234567890' } } });
    expect(patched.statusCode).toBe(200);
    expect(patched.body).not.toContain('sk-should-not-be-stored');
    expect(patched.json().settings).toEqual({ baseUrl: 'http://127.0.0.1:9' });
  });

  test('stores the fix-round limit (default 2, 0 turns the fix loop off)', async () => {
    const { app } = await studioWith(null);
    expect((await app.inject({ url: '/api/info' })).json().settings.maxFixRounds).toBe(2);
    const off = await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxFixRounds: 0 } });
    expect(off.statusCode).toBe(200);
    expect(off.json().maxFixRounds).toBe(0);
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxFixRounds: 6 } })).statusCode).toBe(400);
  });

  test('rejects imports outside approved roots', async () => {
    const { app } = await studioWith(null);
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x', spec: 'y', workspaceMode: 'import', importPath: 'C:/Windows' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/outside the approved/);
  });

  test('blocks cross-origin mutations', async () => {
    const { app } = await studioWith(null);
    const response = await app.inject({ method: 'POST', url: '/api/projects', headers: { origin: 'https://evil.example' },
      payload: { name: 'x', spec: 'y', workspaceMode: 'new' } });
    expect(response.statusCode).toBe(403);
  });

  test('rejects non-JSON mutations without an origin', async () => {
    const { app } = await studioWith(null);
    const response = await app.inject({ method: 'POST', url: '/api/projects',
      headers: { 'content-type': 'text/plain' }, payload: 'plain text' });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'Mutating requests must use application/json' });
  });

  test('requires the bearer token when one is configured', async () => {
    const { app } = await studioWith('test-token-0123456789');
    expect((await app.inject({ url: '/api/info' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/info', headers: { authorization: 'Bearer wrong-token-0123456789' } })).statusCode).toBe(401);
    const ok = await app.inject({ url: '/api/info', headers: { authorization: 'Bearer test-token-0123456789' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain('test-token-0123456789');
  });
});

describe('folder picker and folder import', () => {
  async function studioWithProtected(protectedDir: string): Promise<Studio> {
    const dataDir = tempDir('fs');
    const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
      worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null,
      approvedRoots: [], protectedPaths: [protectedDir] });
    studios.push(studio);
    return studio;
  }

  test('lists folders, approves one, and copy-imports it without touching the original', async () => {
    const source = tempDir('userproj');
    fs.mkdirSync(path.join(source, 'src'));
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.writeFileSync(path.join(source, 'src', 'index.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(source, 'node_modules', 'big.js'), 'skip me');
    const { app } = await studioWithProtected(tempDir('protected'));

    const listing = (await app.inject({ url: `/api/fs/list?path=${encodeURIComponent(source)}` })).json();
    expect(listing.entries.map((e: { name: string }) => e.name)).toEqual(['src']); // node_modules hidden
    expect(listing.approved).toBe(false);

    const blocked = await app.inject({ method: 'POST', url: '/api/projects',
      payload: { name: 'Mine', spec: 'Improve it', workspaceMode: 'import', importPath: source, importStrategy: 'copy' } });
    expect(blocked.statusCode).toBe(400);

    expect((await app.inject({ method: 'POST', url: '/api/fs/approved-roots', payload: { path: source } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/fs/roots' })).json().approvedRoots).toHaveLength(1);

    const wrongStrategy = await app.inject({ method: 'POST', url: '/api/projects',
      payload: { name: 'Mine', spec: 'Improve it', workspaceMode: 'import', importPath: source } });
    expect(wrongStrategy.json().error).toMatch(/Copy into the studio/);

    const created = await app.inject({ method: 'POST', url: '/api/projects',
      payload: { name: 'Mine', spec: 'Improve it', workspaceMode: 'import', importPath: source, importStrategy: 'copy' } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(fs.existsSync(path.join(project.workspacePath, 'src', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(project.workspacePath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(source, '.git'))).toBe(false); // original untouched
    expect(project.integrationBranch).toBe('asf/mine/integration');
  });

  test('refuses to approve or import protected locations', async () => {
    const protectedDir = tempDir('protected');
    fs.mkdirSync(path.join(protectedDir, 'inner'));
    const { app } = await studioWithProtected(protectedDir);
    const approve = await app.inject({ method: 'POST', url: '/api/fs/approved-roots', payload: { path: path.join(protectedDir, 'inner') } });
    expect(approve.statusCode).toBe(400);
    expect(approve.json().error).toMatch(/protected/);
    const listing = (await app.inject({ url: `/api/fs/list?path=${encodeURIComponent(protectedDir)}` })).json();
    expect(listing.protected).toBe(true);
  });
});

describe('project deletion', () => {
  test('deletes a stopped project with its studio workspace, refuses a running one', async () => {
    const { app, ctx } = await studioWith(null);
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Throwaway', workspaceMode: 'sample', sampleName: 'todo-service' } })).json();
    expect(fs.existsSync(project.workspacePath)).toBe(true);
    await app.inject({ method: 'POST', url: `/api/projects/${project.id}/plan`, payload: {} });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/delete`, payload: {} })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/projects/${project.id}/cancel`, payload: {} });
    for (let i = 0; i < 50 && (ctx.repos.tasks.listByProject(project.id).some((t) => t.status === 'running')); i += 1) await new Promise((r) => setTimeout(r, 100));
    const deleted = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/delete`, payload: {} });
    expect(deleted.json()).toEqual({ removedWorkspace: true });
    expect((await app.inject({ url: `/api/projects/${project.id}` })).statusCode).toBe(404);
    // Windows may finish the folder removal in the background.
    for (let i = 0; i < 300 && fs.existsSync(project.workspacePath); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(project.workspacePath)).toBe(false);
  });
});

describe('routing fallback', () => {
  const fake = (id: string) => ({
    id, label: id, kind: 'builtin' as const, editsFiles: false, isAi: true, models: ['big-model', 'small-model'], defaultModel: 'small-model',
    detect: async () => ({ available: true, version: 'test', reason: null }),
    run: async () => ({ text: '', usage: null }),
  });

  test('keeps the requested model and effort when the fallback provider offers it', async () => {
    const dataDir = tempDir('route');
    const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
      worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
      { extraProviders: [fake('fake-a'), fake('fake-b')] });
    studios.push(studio);
    const { registry, repos } = studio.ctx;
    registry.updateProvider('fake-a', { enabled: false });
    registry.updateProvider('fake-b', { enabled: true });
    repos.config.upsertAgentConfig({ role: 'pm', providerId: 'fake-a', model: 'big-model', allowFallback: true, effort: 'high' });
    const resolved = await registry.resolveForRole('pm', ['fake-a', 'fake-b']);
    expect(resolved.adapter.id).toBe('fake-b');
    expect(resolved.model).toBe('big-model');
    expect(resolved.effort).toBe('high');

    repos.config.upsertAgentConfig({ role: 'pm', providerId: 'fake-a', model: 'model-b-does-not-have', allowFallback: true, effort: '' });
    expect((await registry.resolveForRole('pm', ['fake-a', 'fake-b'])).model).toBe('small-model');
  });
  test('a newly discovered Claude login joins the fallback order after the other Claude logins', async () => {
    const dataDir = tempDir('join');
    const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
      worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
      { extraProviders: [fake('claude-code-7')] });
    studios.push(studio);
    const order = studio.ctx.repos.config.getSetting<{ fallbackOrder: string[] }>('studio', { fallbackOrder: [] }).fallbackOrder;
    expect(order.filter((id) => id === 'claude-code-7')).toHaveLength(1);
    expect(order.indexOf('claude-code-7')).toBe(order.indexOf('codex') - 1);
    expect(studio.ctx.registry.get('claude-code-7')).toBeDefined();
    expect(studio.ctx.repos.config.getProviderConfig('claude-code-7')?.enabled).toBe(false); // still opt-in
  });
});

describe('usage limit failover', () => {
  test('a provider that hits its limit is parked and the same turn continues on the next one', async () => {
    const { ProviderLimitError } = await import('../src/providers/types.ts');
    const base = { kind: 'builtin' as const, editsFiles: false, isAi: true, models: ['m'], defaultModel: 'm',
      detect: async () => ({ available: true, version: 't', reason: null }) };
    const limited = { ...base, id: 'lim-a', label: 'lim-a', run: async () => { throw new ProviderLimitError('hit your session limit', new Date(Date.now() + 3_600_000)); } };
    const healthy = { ...base, id: 'ok-b', label: 'ok-b', run: async () => ({ text: 'answer from b', usage: null }) };
    const dataDir = tempDir('limit');
    const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
      worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
      { extraProviders: [limited, healthy] });
    studios.push(studio);
    const { registry, repos, executor } = studio.ctx;
    registry.updateProvider('lim-a', { enabled: true });
    registry.updateProvider('ok-b', { enabled: true });
    repos.config.upsertAgentConfig({ role: 'pm', providerId: 'lim-a', model: 'm', allowFallback: true, effort: '' });
    const project = await studio.projects.create({ name: 'Limits', spec: 'x', workspaceMode: 'new' });
    const out = await executor.run({ project, task: null, role: 'pm', prompt: () => 'hi', cwd: project.workspacePath, mode: 'readonly',
      signal: new AbortController().signal, timeoutMs: 10_000, fallbackOrder: ['lim-a', 'ok-b'] });
    expect(out.providerId).toBe('ok-b');
    expect(out.text).toBe('answer from b');
    expect(registry.limitedUntil('lim-a')).not.toBeNull();
    expect(await registry.unusableReason('lim-a')).toMatch(/usage limit reached/);
    expect(repos.events.list({ projectId: project.id }).some((e) => e.type === 'provider.limit')).toBe(true);
  });
});

describe('single instance per data folder', () => {
  test('a second studio on the same data folder refuses to start without touching state', async () => {
    const { acquireInstanceLock, StudioAlreadyRunningError } = await import('../src/instanceLock.ts');
    const dataDir = tempDir('lock');
    const release = await acquireInstanceLock(dataDir);
    fs.writeFileSync(path.join(dataDir, 'studio.pid'), String(process.ppid)); // pretend another live process holds it
    await expect(acquireInstanceLock(dataDir, 300)).rejects.toBeInstanceOf(StudioAlreadyRunningError);
    fs.writeFileSync(path.join(dataDir, 'studio.pid'), '999999'); // dead pid -> stale lock is taken over
    const releaseAgain = await acquireInstanceLock(dataDir, 300);
    expect(fs.readFileSync(path.join(dataDir, 'studio.pid'), 'utf8')).toBe(String(process.pid));
    releaseAgain();
    release();
  });
});
