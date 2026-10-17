// Phase 3c owner terminals (D-019, AGENT_WORKSPACE_SPEC §14). A fake PTY checks the rules; one test on Windows opens
// a real PowerShell through the WebSocket.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSession, Project } from '@asf/shared';
import { createStudio, type Studio } from '../src/app.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { TerminalManager, type PtyProcess, type PtySpawn } from '../src/terminal/terminalManager.ts';
import { prepareSamples, tempDir, waitFor } from './helpers.ts';

let studios: Studio[] = [];
afterEach(async () => {
  for (const studio of studios) await studio.close().catch(() => undefined);
  studios = [];
});

const agent: ProviderAdapter = {
  id: 'term-agent', label: 'term-agent', kind: 'builtin', editsFiles: true, isAi: true, reportsActivity: true, models: ['m'], defaultModel: 'm',
  detect: async () => ({ available: true, version: 'test', reason: null }),
  run: async () => ({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }),
};

interface FakePty extends PtyProcess {
  written: string[];
  killed: boolean;
  emit(data: string): void;
  spawnedWith: { file: string; args: string[]; cwd: string; env: Record<string, string> };
}

function fakeSpawner(): { spawn: PtySpawn; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const spawn: PtySpawn = (file, args, options) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number }) => void = () => undefined;
    const pty: FakePty = {
      written: [], killed: false, spawnedWith: { file, args, cwd: options.cwd, env: options.env },
      onData: (listener) => { onData = listener; },
      onExit: (listener) => { onExit = listener; },
      write: (data) => { pty.written.push(data); },
      resize: () => undefined,
      kill: () => { pty.killed = true; onExit({ exitCode: 0 }); },
      emit: (data) => onData(data),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys };
}

async function setup(spawn?: PtySpawn, host = '127.0.0.1'): Promise<{ studio: Studio; project: Project }> {
  const dataDir = tempDir('terminals');
  const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
    worktreesDir: path.join(dataDir, 'wt'), samplesDir: prepareSamples(), webDistDir: path.join(dataDir, 'none'), authToken: null,
    approvedRoots: [], host }, { extraProviders: [agent], ptySpawn: spawn });
  studios.push(studio);
  studio.ctx.registry.updateProvider(agent.id, { enabled: true });
  const project = await studio.projects.create({ name: `Terminals ${randomUUID().slice(0, 6)}`, spec: 'Terminals', workspaceMode: 'new' });
  return { studio, project };
}

async function session(studio: Studio, project: Project, mode: 'edit' | 'readonly'): Promise<AgentSession> {
  const response = await studio.app.inject({ method: 'POST', url: `/api/v2/projects/${project.id}/sessions`,
    payload: { role: 'backend', providerId: agent.id, model: 'm', effort: '', mode } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as AgentSession;
}

const open = (studio: Studio, sessionId: string, payload: Record<string, unknown> = { confirm: true }) =>
  studio.app.inject({ method: 'POST', url: `/api/v2/sessions/${sessionId}/terminal`, payload });

describe('owner terminals (Phase 3c)', () => {
  test('opens only for an edit session, in its own worktree, with secrets removed from the environment', async () => {
    const { spawn, ptys } = fakeSpawner();
    const { studio, project } = await setup(spawn);
    const readonly = await session(studio, project, 'readonly');
    expect((await open(studio, readonly.id)).statusCode).toBe(409);
    const edit = await session(studio, project, 'edit');
    expect((await open(studio, edit.id, {})).statusCode).toBe(400); // confirm: true is required

    process.env.ASF_TEST_SECRET_TOKEN = 'do-not-leak';
    process.env.PGPASSWORD = 'pg-secret';
    process.env.DATABASE_URL = 'postgres://u:pw@localhost/db';
    try {
      const opened = await open(studio, edit.id);
      expect(opened.statusCode, opened.body).toBe(201);
      const worktree = studio.ctx.repos.sessions.get(edit.id)!.worktreePath!;
      expect(opened.json()).toMatchObject({ sessionId: edit.id, projectId: project.id, cwd: worktree });
      expect(ptys[0].spawnedWith.cwd).toBe(worktree);
      expect(ptys[0].spawnedWith.env.ASF_TEST_SECRET_TOKEN).toBeUndefined();
      expect(ptys[0].spawnedWith.env.PGPASSWORD).toBeUndefined(); // V21-S6
      expect(ptys[0].spawnedWith.env.DATABASE_URL).toBeUndefined();
      if (process.platform === 'win32') expect(ptys[0].spawnedWith.args).toContain('-NoProfile'); // V21-S8
    } finally {
      delete process.env.ASF_TEST_SECRET_TOKEN;
      delete process.env.PGPASSWORD;
      delete process.env.DATABASE_URL;
    }
    const events = studio.ctx.repos.events.list({ projectId: project.id, limit: 50 });
    expect(events.some((e) => e.type === 'audit.terminal.opened')).toBe(true);
  });

  test('allows at most two terminals, streams the backlog, and logs a redacted transcript on close', async () => {
    const { spawn, ptys } = fakeSpawner();
    const { studio, project } = await setup(spawn);
    const a = await session(studio, project, 'edit');
    const first = (await open(studio, a.id)).json();
    await open(studio, a.id);
    expect((await open(studio, a.id)).statusCode).toBe(409);

    ptys[0].emit('PS> echo hi\r\nhi\r\n');
    const seen: string[] = [];
    const ended: string[] = [];
    const detach = studio.terminals.attach(first.id, { data: (data) => { seen.push(data); }, end: (why) => { ended.push(why); } });
    expect(seen.join('')).toContain('hi');
    const second = studio.terminals.attach(first.id, { data: () => undefined, end: () => undefined });
    // V21-S7: viewers per terminal are capped.
    expect(() => studio.terminals.attach(first.id, { data: () => undefined, end: () => undefined })).toThrow(/another window/);
    second();
    studio.terminals.input(first.id, 'dir\r');
    expect(ptys[0].written).toEqual(['dir\r']);

    ptys[0].emit('token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\r\n');
    const closed = await studio.app.inject({ method: 'DELETE', url: `/api/v2/terminals/${first.id}`, payload: {} });
    expect(closed.statusCode).toBe(200);
    expect(ptys[0].killed).toBe(true);
    expect(ended).toEqual(['closed by the owner']); // viewers are told, so their sockets close
    detach();
    const audit =studio.ctx.repos.events.list({ projectId: project.id, limit: 50 }).find((e) => e.type === 'audit.terminal.closed');
    expect(String(audit?.data?.transcript)).toContain('hi');
    expect(String(audit?.data?.transcript)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect((await open(studio, a.id)).statusCode).toBe(201); // a slot is free again
  });

  test('discarding the session closes its terminals before the worktree is removed', async () => {
    const { spawn, ptys } = fakeSpawner();
    const { studio, project } = await setup(spawn);
    const edit = await session(studio, project, 'edit');
    await open(studio, edit.id);
    const discarded = await studio.app.inject({ method: 'POST', url: `/api/v2/sessions/${edit.id}/discard`, payload: { confirm: true } });
    expect(discarded.statusCode, discarded.body).toBe(200);
    expect(ptys[0].killed).toBe(true);
    expect(studio.terminals.list()).toHaveLength(0);
  });

  test('a busy session refuses a terminal, and deleting the project closes its terminals (V21-S4, V21-S5)', async () => {
    const { spawn, ptys } = fakeSpawner();
    const { studio, project } = await setup(spawn);
    const edit = await session(studio, project, 'edit');
    const actions = (studio.ctx.sessions as unknown as { actions: Map<string, unknown> }).actions;
    actions.set(edit.id, { name: 'discard', controller: new AbortController() });
    expect((await open(studio, edit.id)).statusCode).toBe(409);
    actions.delete(edit.id);
    expect((await open(studio, edit.id)).statusCode).toBe(201);
    await studio.projects.deleteProject(project.id);
    expect(ptys[0].killed).toBe(true);
    expect(studio.terminals.list()).toHaveLength(0);
  });

  test('refuses absolute-form request targets that would skip the security hooks (V21-S1)', async () => {
    const { studio } = await setup(fakeSpawner().spawn);
    // inject() normalises the URL, so this goes over a real socket with a raw request line.
    await studio.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (studio.app.server.address() as { port: number }).port;
    const raw = (target: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.end(`GET ${target} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
      let reply = '';
      socket.on('data', (chunk) => { reply += chunk.toString(); });
      socket.on('end', () => resolve(reply.split('\r\n')[0]));
      socket.on('error', reject);
    });
    expect(await raw(`http://127.0.0.1:${port}/api/v2/terminals`)).toMatch(/ 400 /);
    expect(await raw('/api/v2/terminals')).toMatch(/ 403 /); // the normal form still meets the Host check
  });

  test('kills an idle terminal even while it keeps printing (V21-S9)', async () => {
    const { spawn, ptys } = fakeSpawner();
    const { studio, project } = await setup(spawn);
    const edit = await session(studio, project, 'edit');
    const manager = new TerminalManager(studio.ctx, studio.ctx.sessions, spawn, 50);
    manager.open(edit.id, { cols: 80, rows: 24 });
    const chatter = setInterval(() => ptys[0].emit('tick\r\n'), 10);
    try {
      await waitFor(() => ptys[0].killed, 5_000, 'idle kill');
    } finally {
      clearInterval(chatter);
    }
    expect(manager.list()).toHaveLength(0);
  });

  test('is disabled when the studio listens beyond loopback', async () => {
    const { spawn } = fakeSpawner();
    const dataDir = tempDir('terminals-remote');
    const studio = await createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'ws'),
      worktreesDir: path.join(dataDir, 'wt'), webDistDir: path.join(dataDir, 'none'), approvedRoots: [], host: '0.0.0.0', authToken: 'x'.repeat(32) },
    { ptySpawn: spawn });
    studios.push(studio);
    expect(studio.terminals.unavailableReason()).toMatch(/disabled/);
    expect(() => studio.terminals.open(randomUUID(), { cols: 80, rows: 24 })).toThrow(/disabled/);
  });

  test.runIf(process.platform === 'win32')('a real PowerShell answers through the WebSocket; a foreign Origin is refused', async () => {
    const { studio, project } = await setup();
    const edit = await session(studio, project, 'edit');
    const terminal = (await open(studio, edit.id)).json();
    await studio.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (studio.app.server.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}/api/v2/terminals/${terminal.id}/ws`;

    const foreign = new WebSocket(url, { headers: { Origin: 'http://evil.example' } } as unknown as string[]);
    const refused = await new Promise<number>((resolve) => foreign.addEventListener('close', (e) => resolve(e.code)));
    expect(refused).not.toBe(1000);

    const socket = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
    let output = '';
    socket.addEventListener('message', (e) => { output += String(e.data); });
    await new Promise((resolve) => socket.addEventListener('open', resolve));
    socket.send(JSON.stringify({ type: 'input', data: 'Write-Output ("asf-" + (6*7))\r' }));
    await waitFor(() => output.includes('asf-42'), 20_000, 'PowerShell output');
    expect(fs.existsSync(terminal.cwd)).toBe(true);
    socket.close();
  }, 40_000);
});
