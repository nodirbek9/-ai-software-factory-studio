// Phase 3 workspace sessions (AGENT_WORKSPACE_SPEC.md §4–§8) with fake adapters: no CLI is ever spawned.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSession, Project, SessionTurn, WorkspaceLayout } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import { ProviderError, type ProviderAdapter, type ProviderRunRequest, type ProviderRunResult } from '../src/providers/types.ts';
import { git } from '../src/workspace/git.ts';
import { prepareSamples, tempDir, waitFor } from './helpers.ts';

let studios: Studio[] = [];
afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

const base = { kind: 'builtin' as const, editsFiles: true, isAi: true, reportsActivity: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }) };

interface Agent {
  adapter: ProviderAdapter;
  requests: ProviderRunRequest[];
  /** Resolvers of turns waiting in "hold". */
  holds: (() => void)[];
}

/**
 * The last prompt line (the user's message) is a command: `hold` waits until released or stopped, `fail` throws,
 * `write <file> <text>` writes a file into the cwd; anything else is echoed back.
 */
function fakeAgent(id: string, extra: Partial<Pick<ProviderAdapter, 'supports'>> = {},
  after: (request: ProviderRunRequest, result: ProviderRunResult) => ProviderRunResult = (_r, result) => result): Agent {
  const agent: Agent = { requests: [], holds: [], adapter: undefined as unknown as ProviderAdapter };
  agent.adapter = { ...base, id, label: id, ...extra, run: async (request) => {
    agent.requests.push(request);
    const line = request.prompt.trim().split('\n').at(-1)!.trim();
    request.onOutput?.(`Working on: ${line}\n`);
    if (line === 'hold') {
      await new Promise<void>((resolve, reject) => {
        if (request.signal.aborted) reject(new ProviderError('aborted', false));
        request.signal.addEventListener('abort', () => reject(new ProviderError('aborted', false)), { once: true });
        agent.holds.push(resolve);
      });
    }
    if (line === 'fail') throw new ProviderError('provider exploded', false);
    const write = /^write (\S+) (.+)$/.exec(line);
    if (write) fs.writeFileSync(path.join(request.cwd, write[1]), `${write[2]}\n`);
    return after(request, { text: `echo: ${line}`, usage: { inputTokens: 3, outputTokens: 2, costUsd: null } });
  } };
  return agent;
}

async function setup(agents: Agent[], maxAgentProcesses = 3): Promise<{ studio: Studio; project: Project }> {
  const dataDir = tempDir('sessions');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null, approvedRoots: [] },
  { extraProviders: agents.map((a) => a.adapter) });
  studios.push(studio);
  for (const agent of agents) studio.ctx.registry.updateProvider(agent.adapter.id, { enabled: true });
  studio.ctx.repos.config.setSetting('studio', { maxAgentProcesses });
  const project = await studio.projects.create({ name: `Sessions ${randomUUID().slice(0, 6)}`, spec: 'Workspace sessions', workspaceMode: 'new' });
  return { studio, project };
}

const post = (studio: Studio, url: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  studio.app.inject({ method: 'POST', url, payload, headers });
const get = (studio: Studio, url: string, headers: Record<string, string> = {}) => studio.app.inject({ url, headers });

async function createSession(studio: Studio, project: Project, providerId: string, body: Record<string, unknown> = {}): Promise<AgentSession> {
  const response = await post(studio, `/api/v2/projects/${project.id}/sessions`, { role: 'backend', providerId, model: 'm', effort: '', mode: 'readonly', ...body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as AgentSession;
}

const send = (studio: Studio, sessionId: string, text: string) => post(studio, `/api/v2/sessions/${sessionId}/messages`, { text });
const stored = (studio: Studio, id: string) => studio.ctx.repos.sessions.get(id)!;
const waitStatus = (studio: Studio, id: string, status: AgentSession['status'], label = status) =>
  waitFor(() => stored(studio, id).status === status, 30_000, `session ${label}`);
const turnsOf = (studio: Studio, id: string): SessionTurn[] => studio.ctx.repos.sessions.listTurns(id, { limit: 100 });
const lastAgentTurn = (studio: Studio, id: string): SessionTurn => turnsOf(studio, id).filter((t) => t.author === 'agent').at(-1)!;
const eventsOf = (studio: Studio, project: Project, type: string) =>
  studio.ctx.repos.events.list({ projectId: project.id, limit: 5000 }).filter((e) => e.type === type);

describe('creating sessions', () => {
  test('read-only and edit sessions are data only; edit sessions get their own worktree and branch', async () => {
    const agent = fakeAgent('ws-create');
    const { studio, project } = await setup([agent]);
    const readonly = await createSession(studio, project, 'ws-create', { title: 'Reviewer chat', role: 'reviewer' });
    expect(readonly).toMatchObject({ number: 1, title: 'Reviewer chat', mode: 'readonly', cwdKind: 'integration', branch: null, worktreePath: null,
      status: 'idle', queuePosition: null, continuity: 'replay' });
    expect(readonly).not.toHaveProperty('providerSessionRef');

    const edit = await createSession(studio, project, 'ws-create', { mode: 'edit' });
    expect(edit).toMatchObject({ number: 2, title: 'Session 2', mode: 'edit', cwdKind: 'own-worktree', branch: `asf/${project.slug}/session-2`, status: 'idle' });
    expect(fs.existsSync(edit.worktreePath!)).toBe(true);
    expect(await git(edit.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(edit.branch);

    const list = (await get(studio, `/api/v2/projects/${project.id}/sessions`)).json() as AgentSession[];
    expect(list.map((s) => s.id)).toEqual([readonly.id, edit.id]);
    expect(agent.requests).toEqual([]);
    expect(studio.ctx.budget.snapshot()).toMatchObject({ running: [], queued: [] });
    expect(eventsOf(studio, project, 'session.created')).toHaveLength(2);

    const bad = (body: Record<string, unknown>) => post(studio, `/api/v2/projects/${project.id}/sessions`,
      { role: 'backend', providerId: 'ws-create', model: 'm', effort: '', mode: 'readonly', ...body });
    expect((await bad({ providerId: 'no-such-provider' })).statusCode).toBe(400);
    expect((await bad({ mode: 'write' })).statusCode).toBe(400);
    expect((await bad({ taskId: randomUUID() })).statusCode).toBe(400);
    expect((await post(studio, `/api/v2/projects/${randomUUID()}/sessions`, { role: 'backend', providerId: 'ws-create', model: 'm', mode: 'readonly' })).statusCode).toBe(404);
    expect((await get(studio, `/api/v2/sessions/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe('turns and the process budget', () => {
  test('with one agent process the next session queues with its position, runs later, and a queued turn can be cancelled', async () => {
    const agent = fakeAgent('ws-queue');
    const { studio, project } = await setup([agent], 1);
    const [a, b, c] = [await createSession(studio, project, 'ws-queue'), await createSession(studio, project, 'ws-queue'),
      await createSession(studio, project, 'ws-queue')];

    expect((await send(studio, a.id, 'hold')).statusCode).toBe(202);
    await waitFor(() => stored(studio, a.id).status === 'running' && agent.holds.length === 1, 30_000, 'a running');
    const queued = await send(studio, b.id, 'hello');
    expect(queued.statusCode).toBe(202);
    expect(queued.json().session).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect((await send(studio, c.id, 'later')).json().session).toMatchObject({ status: 'queued', queuePosition: 2 });
    expect((await get(studio, `/api/v2/sessions/${b.id}`)).json()).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(studio.ctx.budget.snapshot().queued.map((q) => [q.id, q.position])).toEqual([[b.id, 1], [c.id, 2]]);

    // One turn at a time per session, whether it is running or waiting for a slot.
    expect((await send(studio, a.id, 'again')).statusCode).toBe(409);
    expect((await send(studio, b.id, 'again')).statusCode).toBe(409);

    // Cancelling the queued turn of c frees its place; b moves to the front.
    expect((await post(studio, `/api/v2/sessions/${c.id}/stop`)).statusCode).toBe(200);
    await waitStatus(studio, c.id, 'idle');
    expect(lastAgentTurn(studio, c.id)).toMatchObject({ outcome: 'stopped', error: 'Cancelled before it started' });
    expect(studio.ctx.budget.snapshot().queued.map((q) => q.id)).toEqual([b.id]);

    agent.holds.shift()!();
    await waitStatus(studio, a.id, 'idle');
    await waitStatus(studio, b.id, 'idle');
    expect(lastAgentTurn(studio, b.id)).toMatchObject({ outcome: 'ok', text: 'echo: hello', providerId: 'ws-queue', modelReported: 'm',
      usage: { inputTokens: 3, outputTokens: 2, costUsd: null }, activity: ['Working on: hello'] });
    expect(agent.requests.map((r) => r.prompt.trim().split('\n').at(-1))).toEqual(['hold', 'hello']);
    expect(eventsOf(studio, project, 'session.updated').some((e) => (e.data?.session as AgentSession | undefined)?.queuePosition === 1)).toBe(true);
    expect(eventsOf(studio, project, 'session.turn').some((e) => e.data?.sessionId === b.id && e.data?.outcome === 'ok')).toBe(true);
    expect(studio.ctx.budget.snapshot()).toMatchObject({ running: [], queued: [] });
  });

  test('stop aborts the running turn and the session stays usable', async () => {
    const agent = fakeAgent('ws-stop');
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-stop');
    await send(studio, session.id, 'hold');
    await waitFor(() => agent.holds.length === 1, 30_000, 'turn running');
    expect((await post(studio, `/api/v2/sessions/${session.id}/stop`)).statusCode).toBe(200);
    await waitStatus(studio, session.id, 'stopped');
    expect(lastAgentTurn(studio, session.id)).toMatchObject({ outcome: 'stopped', error: 'Stopped by the user' });
    expect(agent.requests[0].signal.aborted).toBe(true);
    expect(studio.ctx.budget.snapshot().running).toEqual([]);
    expect((await post(studio, `/api/v2/sessions/${session.id}/stop`)).statusCode).toBe(409);

    await send(studio, session.id, 'hello');
    await waitStatus(studio, session.id, 'idle');
    expect(lastAgentTurn(studio, session.id)).toMatchObject({ outcome: 'ok', text: 'echo: hello' });
  });

  test('restart resends the last user message without a duplicate user turn', async () => {
    const agent = fakeAgent('ws-restart');
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-restart');
    await send(studio, session.id, 'hold');
    await waitFor(() => agent.holds.length === 1, 30_000, 'turn running');
    const restarted = await post(studio, `/api/v2/sessions/${session.id}/restart`);
    expect(restarted.statusCode).toBe(202);
    await waitFor(() => agent.holds.length === 2, 30_000, 'turn running again');
    agent.holds.pop()!();
    await waitStatus(studio, session.id, 'idle');
    const turns = turnsOf(studio, session.id);
    expect(turns.map((t) => [t.author, t.outcome])).toEqual([['user', 'ok'], ['agent', 'stopped'], ['agent', 'ok']]);
  });

  test('one failing session does not affect another one', async () => {
    const agent = fakeAgent('ws-fail');
    const { studio, project } = await setup([agent], 2);
    const failing = await createSession(studio, project, 'ws-fail');
    const healthy = await createSession(studio, project, 'ws-fail');
    await send(studio, failing.id, 'fail');
    await send(studio, healthy.id, 'hello');
    await waitStatus(studio, failing.id, 'failed');
    await waitStatus(studio, healthy.id, 'idle');
    expect(stored(studio, failing.id).lastError).toContain('provider exploded');
    expect(lastAgentTurn(studio, failing.id)).toMatchObject({ outcome: 'error' });
    expect(lastAgentTurn(studio, healthy.id)).toMatchObject({ outcome: 'ok', text: 'echo: hello' });
    // failed → send → queued: a failed session takes the next message.
    await send(studio, failing.id, 'hello again');
    await waitStatus(studio, failing.id, 'idle');
    expect(stored(studio, failing.id).lastError).toBeNull();
  });
});

describe('continuity', () => {
  test('replay resends the earlier turns with the new message', async () => {
    const agent = fakeAgent('ws-replay', { supports: { resume: 'none' } });
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-replay');
    await send(studio, session.id, 'first question');
    await waitStatus(studio, session.id, 'idle');
    await send(studio, session.id, 'second question');
    await waitFor(() => stored(studio, session.id).status === 'idle' && agent.requests.length === 2, 30_000, 'second turn');
    const prompt = agent.requests[1].prompt;
    expect(prompt).toContain('You are the Backend agent');
    expect(prompt).toContain('# Workspace session');
    expect(prompt).toContain('User: first question');
    expect(prompt).toContain('Agent: echo: first question');
    expect(prompt.trim().endsWith('second question')).toBe(true);
    expect(agent.requests[0].prompt).not.toContain('Conversation so far');
    expect(stored(studio, session.id)).toMatchObject({ continuity: 'replay', providerSessionRef: null });
    expect(eventsOf(studio, project, 'session.output').some((e) => e.data?.sessionId === session.id
      && String(e.data?.chunk).includes('Working on: first question'))).toBe(true);
    expect(studio.ctx.repos.usage.totalsForSession(session.id)).toEqual({ inputTokens: 6, outputTokens: 4, costUsd: null });
  });

  test('native continuity passes the provider reference on the next turn and sends only the new message', async () => {
    const agent = fakeAgent('ws-native', { supports: { resume: 'native' } },
      (request, result) => ({ ...result, sessionRef: request.session?.resumeRef ?? 'ref-1' }));
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-native');
    expect(session.continuity).toBe('native');
    await send(studio, session.id, 'remember 42');
    await waitStatus(studio, session.id, 'idle');
    expect(stored(studio, session.id)).toMatchObject({ continuity: 'native', providerSessionRef: 'ref-1' });
    expect(agent.requests[0].session?.resumeRef).toBeNull();
    expect(agent.requests[0].session?.id).toMatch(/^[0-9a-f-]{36}$/);
    await send(studio, session.id, 'what was it');
    await waitFor(() => stored(studio, session.id).status === 'idle' && agent.requests.length === 2, 30_000, 'second turn');
    expect(agent.requests[1].session?.resumeRef).toBe('ref-1');
    expect(agent.requests[1].prompt).toBe('what was it');

    // Changing the model resets the native session: the next turn replays.
    const patched = await studio.app.inject({ method: 'PATCH', url: `/api/v2/sessions/${session.id}`, payload: { model: 'other-model' } });
    expect(patched.json()).toMatchObject({ model: 'other-model', continuity: 'replay' });
    expect(stored(studio, session.id).providerSessionRef).toBeNull();
  });

  test('a native session the CLI cannot resume falls back to replay for that turn', async () => {
    const agent = fakeAgent('ws-lost', { supports: { resume: 'native' } }, (request, result) => {
      if (request.session?.resumeRef) throw new ProviderError(`Session ID ${request.session.resumeRef} is already in use`);
      return { ...result, sessionRef: `ref-${request.session?.id}` };
    });
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-lost');
    await send(studio, session.id, 'first');
    await waitStatus(studio, session.id, 'idle');
    const firstRef = stored(studio, session.id).providerSessionRef;
    await send(studio, session.id, 'second');
    await waitFor(() => stored(studio, session.id).status === 'idle' && agent.requests.length === 3, 30_000, 'fallback turn');
    expect(agent.requests[1].session?.resumeRef).toBe(firstRef);
    expect(agent.requests[2].session?.resumeRef).toBeNull();
    expect(agent.requests[2].prompt).toContain('User: first');
    expect(lastAgentTurn(studio, session.id)).toMatchObject({ outcome: 'ok', text: 'echo: second' });
    expect(stored(studio, session.id).continuity).toBe('replay');
    expect(stored(studio, session.id).providerSessionRef).not.toBe(firstRef);
    expect(eventsOf(studio, project, 'session.continuity')).toHaveLength(1);
  });
});

describe('edit sessions', () => {
  test('a change shows in the diff and merges onto the integration branch with a git.merge event', async () => {
    const agent = fakeAgent('ws-edit');
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-edit', { mode: 'edit' });
    await send(studio, session.id, 'write hello.txt hi there');
    await waitStatus(studio, session.id, 'idle');
    expect(agent.requests[0].cwd).toBe(session.worktreePath);
    expect(agent.requests[0].mode).toBe('edit');
    expect(lastAgentTurn(studio, session.id).filesChanged).toEqual(['hello.txt']);

    const diff = (await get(studio, `/api/v2/sessions/${session.id}/diff`)).json() as { diff: string; files: string[]; truncated: boolean };
    expect(diff.files).toEqual(['hello.txt']);
    expect(diff.diff).toContain('+hi there');
    expect(diff.truncated).toBe(false);
    const files = (await get(studio, `/api/v2/sessions/${session.id}/files`)).json() as { path: string }[];
    expect(files.map((f) => f.path)).toContain('hello.txt');
    expect((await get(studio, `/api/v2/sessions/${session.id}/file?path=hello.txt`)).json()).toMatchObject({ content: 'hi there\n' });

    expect((await studio.app.inject({ method: 'DELETE', url: `/api/v2/sessions/${session.id}`, payload: { confirm: true } })).statusCode).toBe(409);
    expect((await post(studio, `/api/v2/sessions/${session.id}/merge`)).statusCode).toBe(400);
    const merged = await post(studio, `/api/v2/sessions/${session.id}/merge`, { confirm: true });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().files).toEqual(['hello.txt']);
    expect(fs.readFileSync(path.join(project.integrationPath!, 'hello.txt'), 'utf8')).toBe('hi there\n');
    const mergeEvent = eventsOf(studio, project, 'git.merge').find((e) => e.data?.sessionId === session.id);
    expect(mergeEvent?.data).toMatchObject({ files: ['hello.txt'], branch: session.branch });
    expect(await git(session.worktreePath!, ['log', '-1', '--format=%s', 'HEAD~0'])).toMatch(/^wip\(session-1\): write hello\.txt/);
    expect(turnsOf(studio, session.id).at(-1)).toMatchObject({ author: 'system' });
    expect((await post(studio, `/api/v2/sessions/${session.id}/merge`, { confirm: true })).statusCode).toBe(409); // nothing left

    const closed = await studio.app.inject({ method: 'DELETE', url: `/api/v2/sessions/${session.id}`, payload: { confirm: true } });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'closed', worktreePath: null });
    expect((await send(studio, session.id, 'more')).statusCode).toBe(409);
    expect((await get(studio, `/api/v2/projects/${project.id}/sessions`)).json()).toEqual([]);
  });

  test('discard removes the worktree but keeps the branch with the work committed on it', async () => {
    const agent = fakeAgent('ws-discard');
    const { studio, project } = await setup([agent]);
    const session = await createSession(studio, project, 'ws-discard', { mode: 'edit' });
    await send(studio, session.id, 'write draft.txt rough idea');
    await waitStatus(studio, session.id, 'idle');
    expect((await post(studio, `/api/v2/sessions/${session.id}/discard`)).statusCode).toBe(400);
    const discarded = await post(studio, `/api/v2/sessions/${session.id}/discard`, { confirm: true });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(discarded.json()).toMatchObject({ worktreePath: null, branch: session.branch });
    await waitFor(() => !fs.existsSync(session.worktreePath!), 30_000, 'worktree removed');
    expect(await git(project.workspacePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${session.branch}`], true)).not.toBe('');
    expect(await git(project.workspacePath, ['show', `${session.branch}:draft.txt`])).toBe('rough idea');
    expect(fs.existsSync(path.join(project.integrationPath!, 'draft.txt'))).toBe(false);
    expect((await send(studio, session.id, 'more')).statusCode).toBe(409);
    expect(eventsOf(studio, project, 'session.discarded')).toHaveLength(1);
    expect((await studio.app.inject({ method: 'DELETE', url: `/api/v2/sessions/${session.id}`, payload: { confirm: true } })).statusCode).toBe(200);
  });
});

describe('recovery', () => {
  test('a restart marks unfinished turns interrupted, fails their sessions and commits edit work as wip', async () => {
    const agent = fakeAgent('ws-recover');
    const { studio, project } = await setup([agent]);
    const edit = await createSession(studio, project, 'ws-recover', { mode: 'edit' });
    const readonly = await createSession(studio, project, 'ws-recover');
    const { sessions } = studio.ctx.repos;
    // State a crash leaves behind: a running edit turn with unsaved work, a queued read-only turn.
    fs.writeFileSync(path.join(edit.worktreePath!, 'half.txt'), 'half done\n');
    sessions.addTurn({ sessionId: edit.id, author: 'user', text: 'build it', finishedAt: new Date().toISOString(), outcome: 'ok' });
    const unfinished = sessions.addTurn({ sessionId: edit.id, author: 'agent', text: '' });
    sessions.update(edit.id, { status: 'running' });
    sessions.update(readonly.id, { status: 'queued' });

    await studio.ctx.sessions.recover();
    expect(sessions.getTurn(unfinished.id)).toMatchObject({ outcome: 'interrupted', error: expect.stringContaining('restart') });
    expect(sessions.getTurn(unfinished.id)!.finishedAt).not.toBeNull();
    for (const id of [edit.id, readonly.id]) {
      expect(stored(studio, id).status).toBe('failed');
      expect(stored(studio, id).lastError).toContain('restart');
    }
    expect(await git(edit.worktreePath!, ['log', '-1', '--format=%s'])).toMatch(/^wip\(session-1\): partial work/);
    expect(await git(edit.worktreePath!, ['status', '--porcelain'])).toBe('');

    // Restart sends the interrupted message again.
    expect((await post(studio, `/api/v2/sessions/${edit.id}/restart`)).statusCode).toBe(202);
    await waitStatus(studio, edit.id, 'idle');
    expect(lastAgentTurn(studio, edit.id)).toMatchObject({ outcome: 'ok', text: 'echo: build it' });
  });
});

describe('layout, orchestrator messages, budget and security', () => {
  const layout: WorkspaceLayout = {
    version: 1, preset: 2,
    root: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'panel', id: 'p1' }, { type: 'panel', id: 'p2' }] },
    panels: { p1: { sessionId: null, tab: 'chat', kind: 'session' }, p2: { sessionId: null, tab: 'activity', kind: 'orchestrator' } },
    maximized: null, minimized: [], recentlyClosed: [], drawer: { open: false, tab: 'coordination', width: 320 },
  };

  test('the workspace layout round-trips and is validated', async () => {
    const { studio, project } = await setup([fakeAgent('ws-layout')]);
    const url = `/api/v2/projects/${project.id}/workspace-layout`;
    expect((await get(studio, url)).json()).toEqual({ layout: null });
    const put = (payload: unknown) => studio.app.inject({ method: 'PUT', url, payload: payload as Record<string, unknown> });
    const saved = await put(layout);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await get(studio, url)).json()).toEqual({ layout });
    expect((await put({ ...layout, version: 2 })).statusCode).toBe(400);
    expect((await put({ ...layout, root: { type: 'split', dir: 'diagonal', sizes: [], children: [] } })).statusCode).toBe(400);
    expect((await put({ ...layout, note: 'x'.repeat(70_000) })).statusCode).toBe(413);
    expect((await get(studio, url)).json()).toEqual({ layout });
    expect((await get(studio, `/api/v2/projects/${randomUUID()}/workspace-layout`)).statusCode).toBe(404);
  });

  test('an orchestrator message is stored and forwarded only to the ticked sessions', async () => {
    const agent = fakeAgent('ws-orch');
    const { studio, project } = await setup([agent]);
    const ticked = await createSession(studio, project, 'ws-orch');
    const other = await createSession(studio, project, 'ws-orch');
    const url = `/api/v2/projects/${project.id}/orchestrator/messages`;
    const response = await post(studio, url, { text: 'Please stop editing app.ts', forwardTo: [ticked.id] });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().forwarded).toEqual([{ sessionId: ticked.id, ok: true, error: null }]);
    await waitStatus(studio, ticked.id, 'idle');
    expect(turnsOf(studio, ticked.id)[0].text).toContain('Please stop editing app.ts');
    expect(turnsOf(studio, other.id)).toEqual([]);
    const messages = (await get(studio, url)).json() as { content: string; direction: string }[];
    expect(messages).toMatchObject([{ content: 'Please stop editing app.ts', direction: 'user' }]);
  });

  test('budget snapshot routes and the loopback Host check on session routes', async () => {
    const { studio, project } = await setup([fakeAgent('ws-sec')], 2);
    const session = await createSession(studio, project, 'ws-sec');
    expect((await get(studio, '/api/v2/budget')).json()).toEqual({ limit: 2, running: [], queued: [] });
    expect((await get(studio, '/api/v2/system/health')).json().budget).toEqual({ limit: 2, running: [], queued: [] });
    const evil = { host: 'evil.example' };
    expect((await get(studio, `/api/v2/projects/${project.id}/sessions`, evil)).statusCode).toBe(403);
    expect((await post(studio, `/api/v2/sessions/${session.id}/messages`, { text: 'hi' }, evil)).statusCode).toBe(403);
    expect(turnsOf(studio, session.id)).toEqual([]);
  });
});
