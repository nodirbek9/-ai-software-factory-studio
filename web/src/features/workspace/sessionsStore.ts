import { create } from 'zustand';
import type { AgentSession, CreateSessionInput, ProcessBudgetSnapshot, SessionTurn, StudioEvent, WorkspaceLayout } from '@asf/shared';
import { api, post, put } from '@/lib/api';
import { onSessionEvent } from '@/store/studio';
import { createLayout, normalizeLayout } from './layout';

/** Debounce of the layout PUT (AGENT_WORKSPACE_SPEC.md §9). */
export const LAYOUT_SAVE_DEBOUNCE_MS = 1000;
export const TURNS_PAGE_SIZE = 50;
/** Live output kept per watched session; older text is dropped (the persisted turn holds the full text). */
export const LIVE_BUFFER_CHARS = 32_000;

export interface TurnPage {
  /** Ascending by seq. Optimistic user turns have a negative id until the server turn replaces them. */
  items: SessionTurn[];
  /** Pass as ?before= to load older turns; null when the transcript start is loaded. */
  nextBefore: number | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export type SessionAction = 'stop' | 'restart' | 'checkpoint' | 'sync' | 'merge' | 'discard' | 'run-tests';

const EMPTY_PAGE: TurnPage = { items: [], nextBefore: null, loading: false, loaded: false, error: null };

interface SessionsState {
  projectId: string | null;
  sessions: AgentSession[];
  sessionsLoaded: boolean;
  sessionsError: string | null;
  turns: Record<string, TurnPage>;
  /** Live agent output of the running turn, per watched session. */
  live: Record<string, string>;
  budget: ProcessBudgetSnapshot | null;
  layout: WorkspaceLayout | null;
  layoutError: string | null;

  reset: () => void;
  load: (projectId: string) => Promise<void>;
  reloadSessions: () => Promise<void>;
  setLayout: (layout: WorkspaceLayout) => void;
  flushLayout: () => Promise<void>;
  loadTurns: (sessionId: string, older?: boolean) => Promise<void>;
  createSession: (input: CreateSessionInput) => Promise<AgentSession>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  runAction: (sessionId: string, action: SessionAction, body?: Record<string, unknown>) => Promise<unknown>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  closeSession: (sessionId: string) => Promise<void>;
  postOrchestratorMessage: (text: string, forwardTo: string[]) => Promise<void>;
}

// ------------------------------------------------------------------ tolerant response parsing

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function looksLikeSession(value: unknown): value is AgentSession {
  return isObject(value) && typeof value.id === 'string' && typeof value.status === 'string' && 'role' in value;
}

/** The session carried by an event or action response: `{ session }` or the session itself. */
export function pickSession(value: unknown): AgentSession | null {
  if (isObject(value) && looksLikeSession(value.session)) return value.session;
  return looksLikeSession(value) ? value : null;
}

function parseSessions(value: unknown): AgentSession[] {
  const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.sessions) ? value.sessions : [];
  return list.filter(looksLikeSession);
}

function looksLikeTurn(value: unknown): value is SessionTurn {
  return isObject(value) && typeof value.seq === 'number' && typeof value.author === 'string';
}

function parseTurns(value: unknown, limit: number): { turns: SessionTurn[]; nextBefore: number | null } {
  const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.turns) ? value.turns : [];
  const turns = list.filter(looksLikeTurn).sort((a, b) => a.seq - b.seq);
  if (isObject(value) && 'nextBefore' in value) {
    return { turns, nextBefore: typeof value.nextBefore === 'number' ? value.nextBefore : null };
  }
  // No cursor in the response: a full page means there may be older turns before the oldest seq we hold.
  return { turns, nextBefore: turns.length >= limit ? turns[0].seq : null };
}

function parseBudget(value: unknown): ProcessBudgetSnapshot | null {
  const candidate = isObject(value) && isObject(value.budget) ? value.budget : value;
  if (!isObject(candidate) || typeof candidate.limit !== 'number') return null;
  return {
    limit: candidate.limit,
    running: Array.isArray(candidate.running) ? (candidate.running as ProcessBudgetSnapshot['running']) : [],
    queued: Array.isArray(candidate.queued) ? (candidate.queued as ProcessBudgetSnapshot['queued']) : [],
  };
}

function parseLayout(value: unknown): WorkspaceLayout {
  const inner = isObject(value) && !('version' in value) && isObject(value.layout) ? value.layout : value;
  return normalizeLayout(inner);
}

function upsertSession(list: AgentSession[], session: AgentSession): AgentSession[] {
  const index = list.findIndex((item) => item.id === session.id);
  if (index === -1) return [...list, session].sort((a, b) => a.number - b.number);
  const copy = list.slice();
  copy[index] = session;
  return copy;
}

function mergeTurns(existing: SessionTurn[], incoming: SessionTurn[]): SessionTurn[] {
  const bySeq = new Map<number, SessionTurn>();
  for (const turn of existing) if (turn.id >= 0) bySeq.set(turn.seq, turn);
  for (const turn of incoming) bySeq.set(turn.seq, turn);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// ------------------------------------------------------------------ module-level helpers (not reactive)

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let layoutDirty = false;
/** Sessions that currently have a visible panel: only their output is buffered (AGENT_WORKSPACE_SPEC.md §13). */
const watched = new Map<string, number>();
let loadToken = 0;

/** Marks a session as on screen. Returns the function that undoes it (call it from an effect cleanup). */
export function watchSession(sessionId: string): () => void {
  watched.set(sessionId, (watched.get(sessionId) ?? 0) + 1);
  return () => {
    const count = (watched.get(sessionId) ?? 1) - 1;
    if (count <= 0) watched.delete(sessionId);
    else watched.set(sessionId, count);
  };
}

export const useSessions = create<SessionsState>((set, get) => {
  const requireProject = (): string => {
    const id = get().projectId;
    if (!id) throw new Error('No project selected.');
    return id;
  };

  const putSession = (session: AgentSession) => {
    if (session.projectId !== get().projectId) return;
    set((state) => ({ sessions: upsertSession(state.sessions, session) }));
  };

  const refreshSession = async (sessionId: string) => {
    try {
      const session = pickSession(await api<unknown>(`/api/v2/sessions/${sessionId}`));
      if (session) putSession(session);
    } catch {
      // The event stream delivers the same update; a missed refresh is not an error for the user.
    }
  };

  const clearSaveTimer = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  };

  return {
    projectId: null,
    sessions: [],
    sessionsLoaded: false,
    sessionsError: null,
    turns: {},
    live: {},
    budget: null,
    layout: null,
    layoutError: null,

    reset: () => {
      clearSaveTimer();
      layoutDirty = false;
      loadToken += 1;
      set({ projectId: null, sessions: [], sessionsLoaded: false, sessionsError: null, turns: {}, live: {}, budget: null, layout: null, layoutError: null });
    },

    load: async (projectId) => {
      if (get().projectId && get().projectId !== projectId) await get().flushLayout();
      clearSaveTimer();
      layoutDirty = false;
      loadToken += 1;
      const token = loadToken;
      set({ projectId, sessions: [], sessionsLoaded: false, sessionsError: null, turns: {}, live: {}, layout: null, layoutError: null });
      const [sessions, layout, budget] = await Promise.allSettled([
        api<unknown>(`/api/v2/projects/${projectId}/sessions`),
        api<unknown>(`/api/v2/projects/${projectId}/workspace-layout`),
        api<unknown>('/api/v2/budget'),
      ]);
      if (token !== loadToken) return;
      set({
        sessions: sessions.status === 'fulfilled' ? parseSessions(sessions.value) : [],
        sessionsLoaded: true,
        sessionsError: sessions.status === 'rejected' ? errorMessage(sessions.reason) : null,
        layout: layout.status === 'fulfilled' ? parseLayout(layout.value) : createLayout(1),
        layoutError: layout.status === 'rejected' ? errorMessage(layout.reason) : null,
        budget: budget.status === 'fulfilled' ? parseBudget(budget.value) : null,
      });
    },

    reloadSessions: async () => {
      const projectId = get().projectId;
      if (!projectId) return;
      try {
        const sessions = parseSessions(await api<unknown>(`/api/v2/projects/${projectId}/sessions`));
        if (get().projectId === projectId) set({ sessions, sessionsError: null });
      } catch (cause) {
        set({ sessionsError: errorMessage(cause) });
      }
    },

    setLayout: (layout) => {
      set({ layout });
      layoutDirty = true;
      clearSaveTimer();
      saveTimer = setTimeout(() => { void get().flushLayout(); }, LAYOUT_SAVE_DEBOUNCE_MS);
    },

    flushLayout: async () => {
      clearSaveTimer();
      const { projectId, layout } = get();
      if (!layoutDirty || !projectId || !layout) return;
      layoutDirty = false;
      try {
        await put(`/api/v2/projects/${projectId}/workspace-layout`, layout);
        set({ layoutError: null });
      } catch (cause) {
        set({ layoutError: `Layout not saved: ${errorMessage(cause)}` });
      }
    },

    loadTurns: async (sessionId, older = false) => {
      const page = get().turns[sessionId] ?? EMPTY_PAGE;
      if (page.loading) return;
      const before = older ? page.nextBefore : null;
      if (older && before === null) return;
      set((state) => ({ turns: { ...state.turns, [sessionId]: { ...page, loading: true, error: null } } }));
      const query = `${before !== null ? `before=${before}&` : ''}limit=${TURNS_PAGE_SIZE}`;
      try {
        const result = parseTurns(await api<unknown>(`/api/v2/sessions/${sessionId}/turns?${query}`), TURNS_PAGE_SIZE);
        set((state) => {
          const current = state.turns[sessionId] ?? EMPTY_PAGE;
          return {
            turns: {
              ...state.turns,
              [sessionId]: {
                items: mergeTurns(current.items, result.turns),
                // Reloading the newest page must not forget how far back the user already scrolled.
                nextBefore: older || !current.loaded ? result.nextBefore : current.nextBefore ?? result.nextBefore,
                loading: false, loaded: true, error: null,
              },
            },
          };
        });
      } catch (cause) {
        set((state) => ({ turns: { ...state.turns, [sessionId]: { ...(state.turns[sessionId] ?? EMPTY_PAGE), loading: false, error: errorMessage(cause) } } }));
      }
    },

    createSession: async (input) => {
      const session = await post<AgentSession>(`/api/v2/projects/${requireProject()}/sessions`, input);
      const picked = pickSession(session);
      if (!picked) throw new Error('The server did not return the new session.');
      putSession(picked);
      return picked;
    },

    sendMessage: async (sessionId, text) => {
      const page = get().turns[sessionId] ?? EMPTY_PAGE;
      const nextSeq = (page.items.at(-1)?.seq ?? 0) + 1;
      const now = new Date().toISOString();
      const optimistic: SessionTurn = {
        id: -Date.now(), sessionId, seq: nextSeq, author: 'user', text, activity: [], providerId: null, modelReported: null,
        usage: null, filesChanged: [], startedAt: now, finishedAt: now, outcome: null, error: null,
      };
      set((state) => ({
        turns: { ...state.turns, [sessionId]: { ...page, items: [...page.items, optimistic], loaded: true } },
        live: { ...state.live, [sessionId]: '' },
      }));
      try {
        const reply = await post<unknown>(`/api/v2/sessions/${sessionId}/messages`, { text });
        const echoed = isObject(reply) && looksLikeTurn(reply.turn) ? reply.turn : looksLikeTurn(reply) ? reply : null;
        set((state) => {
          const current = state.turns[sessionId] ?? EMPTY_PAGE;
          const items = echoed ? mergeTurns(current.items.filter((t) => t.id !== optimistic.id), [echoed]) : current.items;
          return { turns: { ...state.turns, [sessionId]: { ...current, items } } };
        });
        const session = pickSession(reply);
        if (session) putSession(session);
        else void refreshSession(sessionId);
        void get().loadTurns(sessionId);
      } catch (cause) {
        set((state) => {
          const current = state.turns[sessionId] ?? EMPTY_PAGE;
          return { turns: { ...state.turns, [sessionId]: { ...current, items: current.items.filter((t) => t.id !== optimistic.id) } } };
        });
        throw cause;
      }
    },

    runAction: async (sessionId, action, body = {}) => {
      const reply = await post<unknown>(`/api/v2/sessions/${sessionId}/${action}`, body);
      const session = pickSession(reply);
      if (session) putSession(session);
      else void refreshSession(sessionId);
      if (action === 'restart' || action === 'run-tests') void get().loadTurns(sessionId);
      return reply;
    },

    renameSession: async (sessionId, title) => {
      const reply = await api<unknown>(`/api/v2/sessions/${sessionId}`, { method: 'PATCH', json: { title } });
      const session = pickSession(reply);
      if (session) putSession(session);
      else set((state) => ({ sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)) }));
    },

    closeSession: async (sessionId) => {
      await api<unknown>(`/api/v2/sessions/${sessionId}`, { method: 'DELETE' });
      const closedAt = new Date().toISOString();
      set((state) => ({ sessions: state.sessions.map((s): AgentSession => (s.id === sessionId ? { ...s, status: 'closed', closedAt } : s)) }));
    },

    postOrchestratorMessage: async (text, forwardTo) => {
      await post(`/api/v2/projects/${requireProject()}/orchestrator/messages`, { text, forwardTo });
    },
  };
});

// ------------------------------------------------------------------ live events (session.* and budget.updated)

/** Applies one SSE event from the studio stream. Exported for tests; the store subscribes at module load. */
export function handleSessionEvent(event: StudioEvent): void {
  const state = useSessions.getState();
  const data = event.data ?? {};
  if (event.type === 'budget.updated') {
    const budget = parseBudget(data);
    if (budget) useSessions.setState({ budget });
    return;
  }
  if (event.projectId && state.projectId && event.projectId !== state.projectId) return;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : pickSession(data)?.id;

  switch (event.type) {
    case 'session.created':
    case 'session.updated': {
      const session = pickSession(data);
      if (session && session.projectId === state.projectId) useSessions.setState({ sessions: upsertSession(state.sessions, session) });
      else if (!session) void state.reloadSessions();
      return;
    }
    case 'session.closed': {
      if (!sessionId) return;
      useSessions.setState({
        sessions: state.sessions.map((s): AgentSession => (s.id === sessionId ? { ...s, status: 'closed', closedAt: s.closedAt ?? event.createdAt } : s)),
      });
      return;
    }
    case 'session.output': {
      const chunk = typeof data.chunk === 'string' ? data.chunk : '';
      if (!sessionId || !chunk || !watched.has(sessionId)) return;
      const next = ((state.live[sessionId] ?? '') + chunk).slice(-LIVE_BUFFER_CHARS);
      useSessions.setState({ live: { ...state.live, [sessionId]: next } });
      return;
    }
    case 'session.turn': {
      if (!sessionId) return;
      // The persisted turn replaces the live buffer; only transcripts that were already loaded need the refresh.
      useSessions.setState({ live: { ...state.live, [sessionId]: '' } });
      if (state.turns[sessionId]?.loaded) void state.loadTurns(sessionId);
      return;
    }
    default:
  }
}

onSessionEvent(handleSessionEvent);
