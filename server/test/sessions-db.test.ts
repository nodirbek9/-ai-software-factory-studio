import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { WorkspaceLayout } from '@asf/shared';
import { openDatabase, type Db } from '../src/db/database.ts';
import { createRepositories, type Repositories } from '../src/db/repositories.ts';
import { tempDir } from './helpers.ts';

let open: Db[] = [];
afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function setup(): { db: Db; repos: Repositories; projectId: string; newProject: (slug: string) => string } {
  const db = openDatabase(path.join(tempDir('sessdb'), 'studio.db'));
  open.push(db);
  const repos = createRepositories(db);
  const newProject = (slug: string): string => repos.projects.create({ name: slug, slug, description: '', spec: 'spec',
    workspaceMode: 'new', workspacePath: `/tmp/${slug}`, testCommand: 'npm test' }).id;
  return { db, repos, projectId: newProject('alpha'), newProject };
}

const session = (projectId: string) => ({ projectId, role: 'backend' as const, providerId: 'claude-code', model: 'm', mode: 'readonly' as const,
  cwdKind: 'integration' as const });

function layout(): WorkspaceLayout {
  return {
    version: 1, preset: 2,
    root: { type: 'split', dir: 'row', sizes: [50, 50], children: [{ type: 'panel', id: 'p1' }, { type: 'panel', id: 'p2' }] },
    panels: { p1: { sessionId: 's1', tab: 'chat', kind: 'session' }, p2: { sessionId: null, tab: 'activity', kind: 'orchestrator' } },
    maximized: null, minimized: [], recentlyClosed: [{ sessionId: 's0', title: 'Old', closedAt: '2026-10-16T10:00:00.000Z' }],
    drawer: { open: true, tab: 'coordination', width: 320 },
  };
}

describe('migration', () => {
  test('creates the session tables, indexes and usage_records.session_id', () => {
    const { db } = setup();
    const names = (type: string) => (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(expect.arrayContaining(['agent_sessions', 'session_turns', 'workspace_layouts']));
    expect(names('index')).toEqual(expect.arrayContaining(['idx_agent_sessions_project', 'idx_session_turns_session']));
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
    expect(columns('usage_records')).toContain('session_id');
    expect(columns('agent_sessions')).toEqual(expect.arrayContaining(['provider_session_ref', 'base_commit', 'allow_fallback', 'closed_at']));
  });

  test('rejects values outside the spec CHECK constraints', () => {
    const { repos, projectId } = setup();
    expect(() => repos.sessions.create({ ...session(projectId), mode: 'write' as never })).toThrow();
    expect(() => repos.sessions.create({ ...session(projectId), continuity: 'magic' as never })).toThrow();
  });
});

describe('SessionRepository sessions', () => {
  test('creates sessions with per-project numbers and defaults', () => {
    const { repos, projectId, newProject } = setup();
    const other = newProject('beta');
    const first = repos.sessions.create(session(projectId));
    const second = repos.sessions.create({ ...session(projectId), title: 'Reviewer', mode: 'edit', cwdKind: 'own-worktree',
      branch: 'asf/alpha/session-2', worktreePath: '/tmp/wt', baseCommit: 'abc123', effort: 'high', allowFallback: true, continuity: 'native', taskId: 't1' });
    const foreign = repos.sessions.create(session(other));
    expect([first.number, second.number, foreign.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ title: 'Session 1', status: 'idle', continuity: 'replay', effort: '', allowFallback: false, branch: null,
      worktreePath: null, baseCommit: null, providerSessionRef: null, taskId: null, queuePosition: null, lastError: null,
      lastActivityAt: null, closedAt: null, projectId });
    expect(second).toMatchObject({ title: 'Reviewer', mode: 'edit', cwdKind: 'own-worktree', branch: 'asf/alpha/session-2',
      worktreePath: '/tmp/wt', baseCommit: 'abc123', effort: 'high', allowFallback: true, continuity: 'native', taskId: 't1' });
    expect(repos.sessions.get(second.id)).toEqual(second);
    expect(repos.sessions.get('missing')).toBeNull();
  });

  test('lists open sessions in number order and keeps numbers of closed ones', () => {
    const { repos, projectId } = setup();
    const a = repos.sessions.create(session(projectId));
    const b = repos.sessions.create(session(projectId));
    repos.sessions.update(b.id, { status: 'closed', closedAt: '2026-10-16T12:00:00.000Z' });
    expect(repos.sessions.listByProject(projectId).map((s) => s.id)).toEqual([a.id]);
    expect(repos.sessions.listByProject(projectId, { includeClosed: true }).map((s) => s.number)).toEqual([1, 2]);
    expect(repos.sessions.create(session(projectId)).number).toBe(3);
  });

  test('updates only the given fields and lists by status', () => {
    const { repos, projectId } = setup();
    const created = repos.sessions.create({ ...session(projectId), allowFallback: true });
    const updated = repos.sessions.update(created.id, { status: 'running', providerSessionRef: 'ref-1', lastActivityAt: '2026-10-16T10:00:00.000Z',
      allowFallback: false, lastError: null });
    expect(updated).toMatchObject({ status: 'running', providerSessionRef: 'ref-1', lastActivityAt: '2026-10-16T10:00:00.000Z',
      allowFallback: false, title: created.title, model: 'm' });
    expect(repos.sessions.update(created.id, {})).toEqual(updated);
    expect(repos.sessions.listByStatus('running', 'queued').map((s) => s.id)).toEqual([created.id]);
    expect(repos.sessions.listByStatus('idle')).toEqual([]);
    expect(repos.sessions.listByStatus()).toEqual([]);
  });
});

describe('SessionRepository turns', () => {
  test('numbers turns per session and round-trips every field', () => {
    const { repos, projectId } = setup();
    const a = repos.sessions.create(session(projectId));
    const b = repos.sessions.create(session(projectId));
    const user = repos.sessions.addTurn({ sessionId: a.id, author: 'user', text: 'hello', startedAt: '2026-10-16T10:00:00.000Z',
      finishedAt: '2026-10-16T10:00:00.000Z', outcome: 'ok' });
    const agent = repos.sessions.addTurn({ sessionId: a.id, author: 'agent', text: '', providerId: 'claude-code' });
    const other = repos.sessions.addTurn({ sessionId: b.id, author: 'user', text: 'x' });
    expect([user.seq, agent.seq, other.seq]).toEqual([1, 2, 1]);
    expect(user).toMatchObject({ sessionId: a.id, author: 'user', text: 'hello', activity: [], filesChanged: [], usage: null, error: null,
      outcome: 'ok', finishedAt: '2026-10-16T10:00:00.000Z' });
    expect(agent).toMatchObject({ finishedAt: null, outcome: null, providerId: 'claude-code', modelReported: null });

    const done = repos.sessions.updateTurn(agent.id, { text: 'answer', activity: ['Reading a.ts', 'Editing a.ts'], modelReported: 'real-model',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, filesChanged: ['a.ts'], finishedAt: '2026-10-16T10:01:00.000Z',
      outcome: 'error', error: 'boom' });
    expect(done).toMatchObject({ text: 'answer', activity: ['Reading a.ts', 'Editing a.ts'], modelReported: 'real-model',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, filesChanged: ['a.ts'], finishedAt: '2026-10-16T10:01:00.000Z',
      outcome: 'error', error: 'boom', providerId: 'claude-code' });
    expect(repos.sessions.getTurn(agent.id)).toEqual(done);
    expect(repos.sessions.updateTurn(agent.id, { usage: null, error: null })).toMatchObject({ usage: null, error: null, text: 'answer' });
  });

  test('pages turns newest-last with a before cursor', () => {
    const { repos, projectId } = setup();
    const s = repos.sessions.create(session(projectId));
    for (let i = 1; i <= 5; i += 1) repos.sessions.addTurn({ sessionId: s.id, author: i % 2 ? 'user' : 'agent', text: `t${i}` });
    const seqs = (before?: number, limit = 2) => repos.sessions.listTurns(s.id, { before, limit }).map((t) => t.seq);
    expect(seqs()).toEqual([4, 5]);
    expect(seqs(4)).toEqual([2, 3]);
    expect(seqs(2)).toEqual([1]);
    expect(seqs(1)).toEqual([]);
    expect(seqs(undefined, 50)).toEqual([1, 2, 3, 4, 5]);
    expect(repos.sessions.listTurns('missing', { limit: 5 })).toEqual([]);
  });

  test('caps long text, survives corrupt JSON columns and reports unfinished agent turns', () => {
    const { db, repos, projectId } = setup();
    const s = repos.sessions.create(session(projectId));
    const long = repos.sessions.addTurn({ sessionId: s.id, author: 'agent', text: 'x'.repeat(300_000) });
    expect(long.text.length).toBeLessThan(205_000);
    expect(long.text).toContain('[truncated');
    db.prepare("UPDATE session_turns SET activity = '{broken', files_changed = 'nope', usage = '{' WHERE id = ?").run(long.id);
    expect(repos.sessions.getTurn(long.id)).toMatchObject({ activity: [], filesChanged: [], usage: null });
    repos.sessions.addTurn({ sessionId: s.id, author: 'user', text: 'q' });
    repos.sessions.addTurn({ sessionId: s.id, author: 'agent', text: 'done', finishedAt: '2026-10-16T10:00:00.000Z', outcome: 'ok' });
    expect(repos.sessions.listUnfinishedTurns().map((t) => t.id)).toEqual([long.id]);
  });
});

describe('workspace layouts', () => {
  test('saves, overwrites and loads a layout per project; unreadable JSON loads as null', () => {
    const { db, repos, projectId, newProject } = setup();
    const other = newProject('beta');
    expect(repos.sessions.getLayout(projectId)).toBeNull();
    repos.sessions.saveLayout(projectId, layout());
    expect(repos.sessions.getLayout(projectId)).toEqual(layout());
    const next: WorkspaceLayout = { ...layout(), preset: 'custom', maximized: 'p1' };
    repos.sessions.saveLayout(projectId, next);
    expect(repos.sessions.getLayout(projectId)).toEqual(next);
    expect(repos.sessions.getLayout(other)).toBeNull();
    db.prepare('UPDATE workspace_layouts SET layout = ? WHERE project_id = ?').run('{not json', projectId);
    expect(repos.sessions.getLayout(projectId)).toBeNull();
  });
});

describe('usage and cascade', () => {
  test('stores the session id on usage records and totals it per session', () => {
    const { db, repos, projectId } = setup();
    const s = repos.sessions.create(session(projectId));
    const record = (sessionId?: string | null) => repos.usage.record({ projectId, taskId: null, role: 'backend', providerId: 'claude-code', model: 'm',
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 }, ...(sessionId === undefined ? {} : { sessionId }) });
    record(s.id);
    record(s.id);
    record();
    record(null);
    const ids = (db.prepare('SELECT session_id FROM usage_records ORDER BY id').all() as { session_id: string | null }[]).map((r) => r.session_id);
    expect(ids).toEqual([s.id, s.id, null, null]);
    expect(repos.usage.totalsForSession(s.id)).toEqual({ inputTokens: 200, outputTokens: 40, costUsd: 1 });
    expect(repos.usage.totalsForSession('none')).toBeNull();
  });

  test('deleting a project removes its sessions, turns and layout', () => {
    const { db, repos, projectId } = setup();
    const s = repos.sessions.create(session(projectId));
    repos.sessions.addTurn({ sessionId: s.id, author: 'user', text: 'hi' });
    repos.sessions.saveLayout(projectId, layout());
    repos.projects.delete(projectId);
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    expect([count('agent_sessions'), count('session_turns'), count('workspace_layouts')]).toEqual([0, 0, 0]);
  });
});
