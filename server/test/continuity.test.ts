// Phase 3 provider continuity (AGENT_WORKSPACE_SPEC.md §5–§6): native CLI sessions only for workspace sessions,
// explicit provider routing and session-tagged executor runs. No CLI is ever spawned (runProcess is mocked).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createStudio, type Studio } from '../src/app.ts';
import { ClaudeCodeProvider, CodexProvider } from '../src/providers/cliProviders.ts';
import { NoProviderError } from '../src/providers/registry.ts';
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from '../src/providers/types.ts';
import * as processRunner from '../src/workspace/processRunner.ts';
import { prepareSamples, tempDir } from './helpers.ts';

let studios: Studio[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

function processResult(stdout: string, exitCode = 0): processRunner.RunResult {
  return { stdout, stderr: '', exitCode, durationMs: 1, timedOut: false, aborted: false };
}

const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n');

function request(session?: ProviderRunRequest['session']): ProviderRunRequest {
  return { prompt: 'hi', systemPrompt: 'test', cwd: process.cwd(), mode: 'edit', model: 'haiku', timeoutMs: 1000,
    signal: new AbortController().signal, ...(session ? { session } : {}) };
}

describe('Claude Code session continuity', () => {
  test('task runs keep the V1 arguments and report no session ref', async () => {
    const run = vi.spyOn(processRunner, 'runProcess').mockResolvedValue(processResult(lines({ type: 'result', result: 'ok', session_id: 'ephemeral' })));
    const result = await new ClaudeCodeProvider().run(request());
    const args = run.mock.calls[0][1].args ?? [];
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(result.sessionRef).toBeUndefined();
  });

  test('the first session turn starts a persisted session with the studio session id', async () => {
    const id = randomUUID();
    const run = vi.spyOn(processRunner, 'runProcess').mockResolvedValue(processResult(lines({ type: 'result', result: 'ok', session_id: id })));
    const result = await new ClaudeCodeProvider().run(request({ id, resumeRef: null }));
    const args = run.mock.calls[0][1].args ?? [];
    expect(args[args.indexOf('--session-id') + 1]).toBe(id);
    expect(args).not.toContain('--no-session-persistence');
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(result.sessionRef).toBe(id);
  });

  test('later turns resume the reported session', async () => {
    const run = vi.spyOn(processRunner, 'runProcess').mockResolvedValue(processResult(lines({ type: 'result', result: 'ok', session_id: 'ref-1' })));
    const result = await new ClaudeCodeProvider().run(request({ id: randomUUID(), resumeRef: 'ref-1' }));
    const args = run.mock.calls[0][1].args ?? [];
    expect(args[args.indexOf('--resume') + 1]).toBe('ref-1');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--no-session-persistence');
    expect(result.sessionRef).toBe('ref-1');
  });

  test('the session ref is read from the system/init event when the result event has none', async () => {
    const stdout = lines({ type: 'system', subtype: 'init', session_id: 'from-init' }, { type: 'result', result: 'ok' });
    vi.spyOn(processRunner, 'runProcess').mockImplementation(async (_executable, options) => {
      options.onOutput?.(`${stdout}\n`, 'stdout');
      return processResult(stdout);
    });
    expect((await new ClaudeCodeProvider().run(request({ id: randomUUID(), resumeRef: null }))).sessionRef).toBe('from-init');
  });

  test('declares native resume', () => {
    expect(new ClaudeCodeProvider().supports.resume).toBe('native');
  });
});

describe('Codex session continuity', () => {
  const codexOut = lines({ type: 'thread.started', thread_id: 'thr-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });

  function mockCodex(helpExitCode: number) {
    return vi.spyOn(processRunner, 'runProcess').mockImplementation(async (_executable, options) => {
      const args = options.args ?? [];
      if (args.join(' ') === 'exec resume --help') return processResult('usage: codex exec resume', helpExitCode);
      return processResult(codexOut);
    });
  }

  test('returns the thread id as the session ref', async () => {
    mockCodex(0);
    const result = await new CodexProvider().run(request());
    expect(result.sessionRef).toBe('thr-1');
    expect(result.text).toBe('done');
  });

  test('resumes the thread with `exec resume` when the CLI supports it', async () => {
    const run = mockCodex(0);
    await new CodexProvider().run(request({ id: randomUUID(), resumeRef: 'thr-1' }));
    const args = run.mock.calls.map((call) => call[1].args ?? []).find((a) => a.join(' ') !== 'exec resume --help')!;
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'thr-1', '--json']);
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args[args.length - 1]).toBe('-');
  });

  test('falls back to a fresh exec when `exec resume` is not available', async () => {
    const run = mockCodex(2);
    const provider = new CodexProvider();
    expect(await provider.resumeSupported()).toBe(false);
    await provider.run(request({ id: randomUUID(), resumeRef: 'thr-1' }));
    const args = run.mock.calls.map((call) => call[1].args ?? []).find((a) => a.join(' ') !== 'exec resume --help')!;
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).not.toContain('thr-1');
  });

  test('checks resume support once and only when a ref is given', async () => {
    const run = mockCodex(0);
    const provider = new CodexProvider();
    await provider.run(request({ id: randomUUID(), resumeRef: null }));
    expect(run.mock.calls.some((call) => (call[1].args ?? []).join(' ') === 'exec resume --help')).toBe(false);
    expect(await provider.resumeSupported()).toBe(true);
    expect(await provider.resumeSupported()).toBe(true);
    await provider.run(request({ id: randomUUID(), resumeRef: 'thr-1' }));
    expect(run.mock.calls.filter((call) => (call[1].args ?? []).join(' ') === 'exec resume --help')).toHaveLength(1);
    expect((provider as ProviderAdapter).supports).toBeUndefined();
  });

  test('a missing codex binary means no resume', async () => {
    vi.spyOn(processRunner, 'runProcess').mockRejectedValue(new Error('Executable not found on PATH: codex'));
    expect(await new CodexProvider().resumeSupported()).toBe(false);
  });
});

// ------------------------------------------------------------------ registry + executor

const base = { kind: 'builtin' as const, editsFiles: true, isAi: true, reportsActivity: true, models: ['big-model', 'small-model'],
  defaultModel: 'small-model', detect: async () => ({ available: true, version: 'test', reason: null }) };

interface Recorder { requests: ProviderRunRequest[] }

function fakeAdapter(id: string, recorder: Recorder, extra: Partial<Pick<ProviderAdapter, 'supports' | 'resumeSupported'>> = {},
  answer: (request: ProviderRunRequest) => ProviderRunResult = () => ({ text: `answer from ${id}`, usage: null })): ProviderAdapter {
  return { ...base, id, label: id, ...extra, run: async (req) => {
    recorder.requests.push(req);
    req.onOutput?.(`Editing a.ts\n`);
    return answer(req);
  } };
}

async function studioWith(...adapters: ProviderAdapter[]): Promise<Studio> {
  const dataDir = tempDir('continuity');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
    { extraProviders: adapters });
  studios.push(studio);
  return studio;
}

describe('registry.resolveExplicit', () => {
  test('uses exactly the named provider, falls back only when allowed, else throws', async () => {
    const recorder: Recorder = { requests: [] };
    const studio = await studioWith(fakeAdapter('fake-a', recorder), fakeAdapter('fake-b', recorder));
    const { registry } = studio.ctx;
    registry.updateProvider('fake-a', { enabled: true });
    registry.updateProvider('fake-b', { enabled: true });
    const order = ['fake-b', 'fake-a'];

    const exact = await registry.resolveExplicit('fake-a', 'big-model', 'high', false, order);
    expect(exact.adapter.id).toBe('fake-a');
    expect(exact.model).toBe('big-model');
    expect(exact.effort).toBe('high');
    expect(exact.fallbackFrom).toBeNull();

    registry.updateProvider('fake-a', { enabled: false });
    const fallback = await registry.resolveExplicit('fake-a', 'big-model', 'high', true, order);
    expect(fallback.adapter.id).toBe('fake-b');
    expect(fallback.model).toBe('big-model');
    expect(fallback.fallbackFrom).toBe('fake-a');

    await expect(registry.resolveExplicit('fake-a', 'big-model', 'high', false, order)).rejects.toThrow(NoProviderError);
    await expect(registry.resolveExplicit('fake-a', 'big-model', 'high', false, order)).rejects.toThrow(/fake-a \(fallback is off\).*disabled/);
    await expect(registry.resolveExplicit('no-such-provider', 'm', '', false, order)).rejects.toThrow(/no-such-provider/);
  });
});

describe('AgentExecutor with an explicit provider and a session', () => {
  test('routes to the explicit provider, passes the session, tags events and reports native continuity', async () => {
    const recorder: Recorder = { requests: [] };
    const native = fakeAdapter('sess-native', recorder, { supports: { resume: 'native' } },
      (req) => ({ text: 'ok', usage: { inputTokens: 3, outputTokens: 2, costUsd: null }, sessionRef: req.session?.resumeRef ?? 'ref-x' }));
    const studio = await studioWith(native);
    const { registry, executor } = studio.ctx;
    registry.updateProvider('sess-native', { enabled: true });
    const project = await studio.projects.create({ name: 'Sessions', spec: 'x', workspaceMode: 'new' });
    const continuityArgs: ({ nativeResume: boolean } | undefined)[] = [];
    const streamed: string[] = [];
    const turn = (resumeRef: string | null) => executor.run({ project, task: null, role: 'backend',
      prompt: (_editsFiles, continuity) => { continuityArgs.push(continuity); return 'hello'; },
      cwd: project.workspacePath, mode: 'readonly', signal: new AbortController().signal, timeoutMs: 10_000, fallbackOrder: [],
      explicit: { providerId: 'sess-native', model: 'big-model', effort: 'low', allowFallback: false },
      sessionId: 'session-1', resumeRef, onOutput: (chunk) => streamed.push(chunk) });

    const first = await turn(null);
    expect(first.providerId).toBe('sess-native');
    expect(first.model).toBe('big-model');
    expect(first.sessionRef).toBe('ref-x');
    expect(first.continuity).toBe('native');
    expect(recorder.requests[0].session).toEqual({ id: 'session-1', resumeRef: null });
    expect(recorder.requests[0].effort).toBe('low');
    expect(continuityArgs[0]).toEqual({ nativeResume: false });
    expect(streamed).toEqual(['Editing a.ts\n']);

    const second = await turn('ref-x');
    expect(recorder.requests[1].session).toEqual({ id: 'session-1', resumeRef: 'ref-x' });
    expect(continuityArgs[1]).toEqual({ nativeResume: true });
    expect(second.sessionRef).toBe('ref-x');

    const events = studio.ctx.repos.events.list({ projectId: project.id });
    for (const type of ['agent.started', 'agent.output']) {
      const tagged = events.filter((e) => e.type === type);
      expect(tagged.length, type).toBeGreaterThan(0);
      for (const event of tagged) expect(event.data?.sessionId, type).toBe('session-1');
    }
  });

  test('a provider that cannot resume reports replay continuity', async () => {
    const recorder: Recorder = { requests: [] };
    const replay = fakeAdapter('sess-replay', recorder, { supports: { resume: 'none' } },
      () => ({ text: 'ok', usage: null, sessionRef: 'ignored-ref' }));
    const runtimeNo = fakeAdapter('sess-runtime-no', recorder, { resumeSupported: async () => false },
      () => ({ text: 'ok', usage: null, sessionRef: 'thread-1' }));
    const studio = await studioWith(replay, runtimeNo);
    const { registry, executor } = studio.ctx;
    registry.updateProvider('sess-replay', { enabled: true });
    registry.updateProvider('sess-runtime-no', { enabled: true });
    const project = await studio.projects.create({ name: 'Replay', spec: 'x', workspaceMode: 'new' });
    for (const providerId of ['sess-replay', 'sess-runtime-no']) {
      const out = await executor.run({ project, task: null, role: 'backend', prompt: () => 'hello', cwd: project.workspacePath,
        mode: 'readonly', signal: new AbortController().signal, timeoutMs: 10_000, fallbackOrder: [],
        explicit: { providerId, model: '', effort: '', allowFallback: false }, sessionId: 'session-2', resumeRef: 'old-ref' });
      expect(out.continuity, providerId).toBe('replay');
    }
  });

  test('a fallback provider does not receive the previous provider\'s resume ref', async () => {
    const recorder: Recorder = { requests: [] };
    const studio = await studioWith(fakeAdapter('sess-a', recorder, { supports: { resume: 'native' } }),
      fakeAdapter('sess-b', recorder, { supports: { resume: 'native' } }));
    const { registry, executor } = studio.ctx;
    registry.updateProvider('sess-a', { enabled: false });
    registry.updateProvider('sess-b', { enabled: true });
    const project = await studio.projects.create({ name: 'Fallback', spec: 'x', workspaceMode: 'new' });
    const input = { project, task: null, role: 'backend' as const, prompt: () => 'hello', cwd: project.workspacePath, mode: 'readonly' as const,
      signal: new AbortController().signal, timeoutMs: 10_000, fallbackOrder: ['sess-a', 'sess-b'], sessionId: 'session-3', resumeRef: 'ref-of-a' };
    await expect(executor.run({ ...input, explicit: { providerId: 'sess-a', model: 'big-model', effort: '', allowFallback: false } }))
      .rejects.toThrow(NoProviderError);
    const out = await executor.run({ ...input, explicit: { providerId: 'sess-a', model: 'big-model', effort: '', allowFallback: true } });
    expect(out.providerId).toBe('sess-b');
    expect(recorder.requests[0].session).toEqual({ id: 'session-3', resumeRef: null });
    const fallback = studio.ctx.repos.events.list({ projectId: project.id }).find((e) => e.type === 'provider.fallback');
    expect(fallback?.data?.sessionId).toBe('session-3');
  });

  test('task/chat runs without session fields are unchanged', async () => {
    const recorder: Recorder = { requests: [] };
    const studio = await studioWith(fakeAdapter('plain', recorder, { supports: { resume: 'native' } }, () => ({ text: 'ok', usage: null, sessionRef: 'x' })));
    const { registry, repos, executor } = studio.ctx;
    registry.updateProvider('plain', { enabled: true });
    repos.config.upsertAgentConfig({ role: 'pm', providerId: 'plain', model: 'big-model', allowFallback: false, effort: '' });
    const project = await studio.projects.create({ name: 'Plain', spec: 'x', workspaceMode: 'new' });
    const out = await executor.run({ project, task: null, role: 'pm', prompt: () => 'hi', cwd: project.workspacePath, mode: 'readonly',
      signal: new AbortController().signal, timeoutMs: 10_000, fallbackOrder: [] });
    expect(out.providerId).toBe('plain');
    expect(recorder.requests[0].session).toBeUndefined();
    expect(out.sessionRef).toBeNull();
    expect(out.continuity).toBe('replay');
    const events = repos.events.list({ projectId: project.id }).filter((e) => e.type.startsWith('agent.'));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.data?.sessionId).toBeUndefined();
  });
});
