// Phase 0b regression tests (docs/v2/phases/PHASE_0B.md): one block per audit risk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Task } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import { claudeConfigDirs, loadConfig } from '../src/config.ts';
import { ClaudeCodeProvider } from '../src/providers/cliProviders.ts';
import { ProviderError, type ProviderAdapter, type ProviderRunRequest } from '../src/providers/types.ts';
import { registerSecret } from '../src/security/redact.ts';
import { runAllowedCommand } from '../src/workspace/commandRunner.ts';
import { commitAll, git } from '../src/workspace/git.ts';
import * as processRunner from '../src/workspace/processRunner.ts';
import { isSensitivePath, WorkspaceManager } from '../src/workspace/workspaceManager.ts';
import { approvePlan, createRun, prepareSamples, projectOf, taskByKey, tempDir, waitFor } from './helpers.ts';

let studios: Studio[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

async function studioWith(...adapters: ProviderAdapter[]): Promise<Studio> {
  const dataDir = tempDir('harden');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
    { extraProviders: adapters });
  studios.push(studio);
  for (const adapter of adapters) {
    studio.ctx.registry.updateProvider(adapter.id, { enabled: true });
    for (const role of ['pm', 'architect', 'backend', 'frontend', 'qa', 'security', 'reviewer'] as const) {
      studio.ctx.repos.config.upsertAgentConfig({ role, providerId: adapter.id, model: 'm', allowFallback: false, effort: '' });
    }
  }
  return studio;
}

const base = { kind: 'builtin' as const, editsFiles: true, isAi: true, reportsActivity: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }) };

const PASSING_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILING_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('broken', () => assert.fail('broken'));\n";

/** A fake agent: plans the given tasks, passes reviews, and lets the caller decide what implement/test turns write. */
function scriptedAgent(id: string, plan: { key: string; title: string; role: string; dependsOn: string[] }[],
  work: (request: ProviderRunRequest) => void): ProviderAdapter {
  return { ...base, id, label: id, run: async (request) => {
    const kind = request.task?.kind;
    if (kind === 'plan') return { text: JSON.stringify({ tasks: plan }), usage: null };
    if (kind === 'architecture') return { text: '# Plan\n\nImplement the planned tasks and verify them with tests.', usage: null };
    if (kind === 'security' || kind === 'review') return { text: 'Looks fine.\nVERDICT: PASS', usage: null };
    work(request);
    return { text: 'done', usage: null };
  } };
}

function writeFile(root: string, relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

async function runToEnd(studio: Studio, name: string): Promise<string> {
  const project = await studio.projects.create({ name, spec: `${name} spec`, workspaceMode: 'new', testCommand: 'node --test' });
  studio.projects.startPlanning(project.id);
  await approvePlan(studio, project.id);
  await waitFor(() => ['completed', 'failed'].includes(projectOf(studio, project.id).status), 90_000, `${name} end`);
  return project.id;
}

describe('R4 host allowlist (DNS rebinding)', () => {
  test('rejects a foreign Host on reads and writes while bound to loopback', async () => {
    const { app } = await studioWith();
    const evil = { host: 'attacker.example:4317' };
    expect((await app.inject({ method: 'GET', url: '/api/info', headers: evil })).statusCode).toBe(403);
    const write = await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxFixRounds: 0 },
      headers: { ...evil, origin: 'http://attacker.example:4317', 'content-type': 'application/json' } });
    expect(write.statusCode).toBe(403);
    for (const host of ['localhost:4317', '127.0.0.1:5317', '[::1]:4317', 'localhost']) {
      expect((await app.inject({ method: 'GET', url: '/api/info', headers: { host } })).statusCode, host).toBe(200);
    }
  });
});

describe('R8 every Claude login folder is protected', () => {
  test('discovers all .claude* entries of a home folder', () => {
    const home = tempDir('home');
    for (const name of ['.claude', '.claude-account4', '.claude-account9', '.claude-work', 'other']) fs.mkdirSync(path.join(home, name));
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    expect(claudeConfigDirs(home).map((dir) => path.basename(dir)).sort())
      .toEqual(['.claude', '.claude-account4', '.claude-account9', '.claude-work', '.claude.json']);
  });

  test('the loaded configuration protects the discovered folders', () => {
    const config = loadConfig({ dataDir: tempDir('cfg8') });
    for (const dir of claudeConfigDirs(os.homedir())) expect(config.protectedPaths).toContain(path.resolve(dir));
  });
});

describe('R2 retries and dispatch respect dependencies', () => {
  function seed(studio: Studio, statusA: Task['status'], statusB: Task['status']): { a: Task; b: Task } {
    const { repos } = studio.ctx;
    const project = repos.projects.create({ name: 'Deps', slug: `deps-${statusB}`, description: '', spec: 'x', workspaceMode: 'new',
      workspacePath: tempDir('deps'), testCommand: 'npm test' });
    repos.projects.update(project.id, { status: 'running' });
    const runId = createRun(repos, project.id).id;
    const a = repos.tasks.create(project.id, { runId, key: 'a', title: 'A', description: '', role: 'backend', kind: 'implement', dependsOn: [],
      orderIndex: 1, maxAttempts: 1, status: statusA });
    const b = repos.tasks.create(project.id, { runId, key: 'b', title: 'B', description: '', role: 'backend', kind: 'implement', dependsOn: ['a'],
      orderIndex: 2, maxAttempts: 1, status: statusB });
    return { a, b };
  }

  test('a retried task waits instead of running when its dependency is not completed', async () => {
    const studio = await studioWith();
    const { b } = seed(studio, 'failed', 'cancelled');
    studio.scheduler.retryTask(b.id);
    expect(studio.scheduler.isRunning(b.id)).toBe(false);
    expect(['pending', 'blocked']).toContain(studio.ctx.repos.tasks.get(b.id)!.status);
  });

  test('dispatch never starts a ready task whose dependency is not completed', async () => {
    const studio = await studioWith();
    const { b } = seed(studio, 'failed', 'ready');
    studio.scheduler.tick(b.projectId);
    expect(studio.scheduler.isRunning(b.id)).toBe(false);
    expect(['pending', 'blocked']).toContain(studio.ctx.repos.tasks.get(b.id)!.status);
  });
});

describe('R7 interrupted work survives a failed save', () => {
  test('keeps the worktree when the partial-work commit fails', async () => {
    const agent = scriptedAgent('r7', [{ key: 'build', title: 'Build', role: 'backend', dependsOn: [] }], (request) => {
      if (request.task?.kind === 'test') return writeFile(request.cwd, 'test/ok.test.js', PASSING_TEST);
      writeFile(request.cwd, `part-${request.task?.attempt}.txt`, 'work');
      if (request.task?.attempt === 1) throw new ProviderError('connection dropped mid-run');
    });
    const studio = await studioWith(agent);
    const commit = studio.ctx.workspace.commit.bind(studio.ctx.workspace);
    vi.spyOn(studio.ctx.workspace, 'commit').mockImplementation(async (dir, message) => {
      if (message.startsWith('wip(')) throw new Error('disk full');
      return commit(dir, message);
    });
    const projectId = await runToEnd(studio, 'Keep');
    const kept = studio.ctx.repos.events.list({ projectId, limit: 2000 })
      .find((e) => e.type === 'task.partial' && e.level === 'error' && /kept/i.test(e.message));
    expect(kept, 'error event that names the kept worktree').toBeTruthy();
    const keptPath = (kept!.data as { worktreePath: string }).worktreePath;
    expect(fs.existsSync(path.join(keptPath, 'part-1.txt'))).toBe(true);
  });
});

describe('R1 path containment through links', () => {
  test('rejects writes through a junction into a missing nested path', () => {
    const dataDir = tempDir('r1');
    const config = loadConfig({ dataDir, workspacesDir: path.join(dataDir, 'ws'), worktreesDir: path.join(dataDir, 'wt'), approvedRoots: [] });
    const manager = new WorkspaceManager(config);
    const root = path.join(config.workspacesDir, 'p');
    fs.mkdirSync(root, { recursive: true });
    const outside = tempDir('outside');
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    expect(() => manager.resolveInside(root, 'link/new/file.txt')).toThrow(/escapes/);
    expect(() => manager.applyEdits(root, [{ path: 'link/new/file.txt', content: 'x' }])).toThrow();
    expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
    expect(manager.resolveInside(root, 'deep/new/dir/file.txt')).toBe(path.join(fs.realpathSync.native(root), 'deep', 'new', 'dir', 'file.txt'));
  });
});

describe('S1/R6 untrusted repositories cannot run code through the studio', () => {
  test('Claude runs without any setting source (repository hooks are not loaded)', async () => {
    const run = vi.spyOn(processRunner, 'runProcess').mockResolvedValue({ stdout: JSON.stringify({ type: 'result', result: 'ok' }), stderr: '',
      exitCode: 0, durationMs: 1, timedOut: false, aborted: false });
    await new ClaudeCodeProvider().run({ prompt: 'hi', systemPrompt: 'test', cwd: process.cwd(), mode: 'edit', model: 'haiku',
      timeoutMs: 1000, signal: new AbortController().signal });
    const args = run.mock.calls[0][1].args ?? [];
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  test('studio git commands never run repository hooks', async () => {
    const dir = tempDir('hooks');
    await git(dir, ['init', '-q', '-b', 'main']);
    writeFile(dir, '.git/hooks/pre-commit', '#!/bin/sh\necho ran > hook-ran.txt\n');
    writeFile(dir, 'a.txt', 'a');
    await commitAll(dir, 'first');
    expect(fs.existsSync(path.join(dir, 'hook-ran.txt'))).toBe(false);
  });

  test('test commands do not inherit secret-looking environment variables', async () => {
    const dir = tempDir('env');
    writeFile(dir, 'print-env.js', "require('fs').writeFileSync('env.json', JSON.stringify(process.env));\n");
    process.env.FAKE_SERVICE_API_KEY = 'abc123';
    process.env.FAKE_PLAIN_SETTING = 'visible';
    try {
      await runAllowedCommand('node print-env.js', dir, { timeoutMs: 30_000, approved: true });
      const env = JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')) as Record<string, string>;
      expect(env.FAKE_SERVICE_API_KEY).toBeUndefined();
      expect(env.FAKE_PLAIN_SETTING).toBe('visible');
    } finally {
      delete process.env.FAKE_SERVICE_API_KEY;
      delete process.env.FAKE_PLAIN_SETTING;
    }
  });
});

describe('R5 sensitive files and redacted responses', () => {
  test('classifies secret files', () => {
    for (const file of ['.env', 'config/.env.local', 'certs/server.pem', 'keys/app.key', 'id_rsa', 'deploy/id_ed25519', 'store.pfx', 'a/b.p12']) {
      expect(isSensitivePath(file), file).toBe(true);
    }
    for (const file of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'id_rsa.pub', 'keyboard.ts']) {
      expect(isSensitivePath(file), file).toBe(false);
    }
  });

  test('the file API refuses secret files and commits never include them', async () => {
    const { app, projects } = await studioWith();
    const project = await projects.create({ name: 'Secrets', spec: 'x', workspaceMode: 'new' });
    const root = project.integrationPath!;
    writeFile(root, '.env', 'TOKEN=abc');
    const response = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/file?path=.env` });
    expect(response.statusCode).toBe(403);
    const dir = tempDir('commit');
    await git(dir, ['init', '-q', '-b', 'main']);
    writeFile(dir, '.env', 'TOKEN=abc');
    writeFile(dir, 'certs/server.pem', 'key');
    writeFile(dir, 'app.js', 'x');
    await commitAll(dir, 'first');
    expect(await git(dir, ['ls-files'])).toBe('app.js');
  });

  test('copy import skips secret files', async () => {
    const parent = tempDir('srcroot');
    const source = path.join(parent, 'repo');
    writeFile(source, 'app.js', 'x');
    writeFile(source, '.env', 'TOKEN=abc');
    writeFile(source, '.env.example', 'TOKEN=');
    const dataDir = tempDir('copy');
    const config = { ...loadConfig({ dataDir, workspacesDir: path.join(dataDir, 'ws'), worktreesDir: path.join(dataDir, 'wt'), approvedRoots: [parent] }),
      protectedPaths: [] }; // the temp folder lives under AppData, which is protected by default
    const target = await new WorkspaceManager(config).importByCopy('copied', source);
    expect(fs.existsSync(path.join(target, 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.env.example'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
  });

  test('registered secrets never appear in JSON responses', async () => {
    const { app, projects } = await studioWith();
    registerSecret('sekret-value-0b-123456');
    const project = await projects.create({ name: 'Leak', spec: 'deploy with sekret-value-0b-123456', workspaceMode: 'new' });
    for (const url of ['/api/projects', `/api/projects/${project.id}`]) {
      const body = (await app.inject({ method: 'GET', url })).body;
      expect(body, url).not.toContain('sekret-value-0b-123456');
    }
  });
});

describe('R3 tests always run on the final integrated code', () => {
  test('a write after the QA task is caught before the security review passes', async () => {
    const agent = scriptedAgent('r3', [
      { key: 'check', title: 'Tests first', role: 'qa', dependsOn: [] },
      { key: 'build', title: 'Build after the tests', role: 'backend', dependsOn: ['check'] },
    ], (request) => {
      if (request.task?.kind === 'test') return writeFile(request.cwd, 'test/ok.test.js', PASSING_TEST);
      writeFile(request.cwd, 'test/late.test.js', FAILING_TEST);
    });
    const studio = await studioWith(agent);
    studio.ctx.repos.config.setSetting('studio', { maxFixRounds: 0 });
    const projectId = await runToEnd(studio, 'Late');
    const security = taskByKey(studio, projectId, 'security-review')!;
    expect(security.status).toBe('failed');
    expect(security.testResult?.passed).toBe(false);
    expect(projectOf(studio, projectId).status).toBe('failed');
  });
});
