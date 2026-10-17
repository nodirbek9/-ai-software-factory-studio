import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFetchMock } from '@/test/fetchMock';
import { budgetFixture, eventFixture, sessionFixture, turnFixture } from '@/test/sessionFixtures';
import { LIVE_BUFFER_CHARS, handleSessionEvent, useSessions, watchSession } from './sessionsStore';

beforeEach(() => {
  useSessions.getState().reset();
  useSessions.setState({ projectId: 'project-1' });
});

const output = (sessionId: string, chunk: string) => eventFixture({ type: 'session.output', data: { sessionId, chunk } });

describe('session events', () => {
  it('buffers live output only for sessions that are on screen', () => {
    const unwatch = watchSession('s1');
    handleSessionEvent(output('s1', 'abc'));
    handleSessionEvent(output('s1', 'def'));
    handleSessionEvent(output('s2', 'hidden'));
    expect(useSessions.getState().live).toEqual({ s1: 'abcdef' });
    unwatch();
    handleSessionEvent(output('s1', 'late'));
    expect(useSessions.getState().live).toEqual({ s1: 'abcdef' });
  });

  it('keeps only the tail of very long output', () => {
    const unwatch = watchSession('s1');
    handleSessionEvent(output('s1', 'x'.repeat(LIVE_BUFFER_CHARS)));
    handleSessionEvent(output('s1', 'END'));
    const live = useSessions.getState().live.s1;
    expect(live).toHaveLength(LIVE_BUFFER_CHARS);
    expect(live.endsWith('END')).toBe(true);
    unwatch();
  });

  it('applies session.created / updated / closed and ignores other projects', () => {
    handleSessionEvent(eventFixture({ type: 'session.created', data: { session: sessionFixture() } }));
    handleSessionEvent(eventFixture({ type: 'session.created', data: { session: sessionFixture({ id: 's2', number: 2 }) } }));
    handleSessionEvent(eventFixture({ type: 'session.updated', data: { session: sessionFixture({ status: 'running' }) } }));
    expect(useSessions.getState().sessions.map((s) => [s.id, s.status])).toEqual([['s1', 'running'], ['s2', 'idle']]);
    handleSessionEvent(eventFixture({ type: 'session.created', projectId: 'other', data: { session: sessionFixture({ id: 's9', projectId: 'other' }) } }));
    expect(useSessions.getState().sessions).toHaveLength(2);
    handleSessionEvent(eventFixture({ type: 'session.closed', data: { sessionId: 's2' } }));
    expect(useSessions.getState().sessions.find((s) => s.id === 's2')?.status).toBe('closed');
  });

  it('stores budget snapshots from budget.updated (bare or wrapped)', () => {
    handleSessionEvent(eventFixture({ type: 'budget.updated', projectId: null, data: { ...budgetFixture({ limit: 4 }) } }));
    expect(useSessions.getState().budget?.limit).toBe(4);
    handleSessionEvent(eventFixture({ type: 'budget.updated', projectId: null, data: { budget: budgetFixture({ limit: 2 }) } }));
    expect(useSessions.getState().budget?.limit).toBe(2);
    handleSessionEvent(eventFixture({ type: 'budget.updated', projectId: null, data: { nonsense: true } }));
    expect(useSessions.getState().budget?.limit).toBe(2);
  });

  it('replaces the live buffer with the persisted turn when a loaded transcript gets session.turn', async () => {
    const network = installFetchMock({
      'GET /api/v2/sessions/s1/turns?limit=50': { turns: [turnFixture(), turnFixture({ id: 2, seq: 2, author: 'agent', text: 'Done' })], nextBefore: null },
    });
    useSessions.setState({ live: { s1: 'partial' }, turns: { s1: { items: [turnFixture()], nextBefore: null, loading: false, loaded: true, error: null } } });
    handleSessionEvent(eventFixture({ type: 'session.turn', data: { sessionId: 's1', seq: 2, outcome: 'ok' } }));
    expect(useSessions.getState().live.s1).toBe('');
    await waitFor(() => expect(useSessions.getState().turns.s1.items).toHaveLength(2));
    expect(network.calls.map((c) => c.path)).toEqual(['/api/v2/sessions/s1/turns?limit=50']);
  });

  it('does not fetch a transcript that was never loaded', () => {
    const network = installFetchMock({});
    handleSessionEvent(eventFixture({ type: 'session.turn', data: { sessionId: 's1', seq: 1, outcome: 'ok' } }));
    expect(network.calls).toEqual([]);
  });
});

describe('turn paging', () => {
  it('loads the newest page, then older turns with the before cursor', async () => {
    const network = installFetchMock({
      'GET /api/v2/sessions/s1/turns?limit=50': { turns: [turnFixture({ id: 3, seq: 3 }), turnFixture({ id: 4, seq: 4 })], nextBefore: 3 },
      'GET /api/v2/sessions/s1/turns?before=3&limit=50': [turnFixture({ id: 1, seq: 1 }), turnFixture({ id: 2, seq: 2 })],
    });
    await useSessions.getState().loadTurns('s1');
    expect(useSessions.getState().turns.s1.nextBefore).toBe(3);
    await useSessions.getState().loadTurns('s1', true);
    const page = useSessions.getState().turns.s1;
    expect(page.items.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
    expect(page.nextBefore).toBeNull();
    expect(network.calls).toHaveLength(2);
  });

  it('reports a failed transcript load without losing the turns it has', async () => {
    installFetchMock({});
    useSessions.setState({ turns: { s1: { items: [turnFixture()], nextBefore: null, loading: false, loaded: true, error: null } } });
    await useSessions.getState().loadTurns('s1');
    const page = useSessions.getState().turns.s1;
    expect(page.error).toMatch(/No mock route/);
    expect(page.items).toHaveLength(1);
  });
});
