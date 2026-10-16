import { create } from 'zustand';
import type {
  AgentConfig, AgentMessage, AgentRole, AgentTestResult, Approval, CreateProjectInput, Project, ProjectSnapshot, ProviderInfo, ServerInfo,
  LiveSnapshot, StudioEvent, StudioSettings, Task,
} from '@asf/shared';
import { api, eventsUrl, patch, post, put } from '@/lib/api';

export const VIEWS = ['home', 'dashboard', 'monitor', 'projects', 'agents', 'workflows', 'files', 'logs', 'providers', 'settings', 'models', 'workspace', 'builder', 'tasks', 'repos', 'quality'] as const;
export type View = (typeof VIEWS)[number];

/** V2 hash slugs per view (#/home, #/tasks, …). The V1 hashes (#/dashboard, #/monitor, …) keep working as aliases;
 *  the V1 Dashboard is the "Project board" (#/board). */
const VIEW_SLUGS: Record<View, string> = {
  home: 'home', dashboard: 'board', monitor: 'runs', projects: 'projects', agents: 'agents', workflows: 'task-graph', files: 'files',
  logs: 'logs', providers: 'providers', settings: 'settings', models: 'models', workspace: 'workspace', builder: 'builder', tasks: 'tasks', repos: 'repos', quality: 'quality',
};
const SLUG_VIEWS: Record<string, View> = {
  ...Object.fromEntries(VIEWS.map((view) => [view, view])),
  ...Object.fromEntries(Object.entries(VIEW_SLUGS).map(([view, slug]) => [slug, view as View])),
};

export function viewFromHash(hash: string): View {
  return SLUG_VIEWS[hash.replace(/^#\/?/, '').split(/[/?]/)[0]] ?? 'home';
}

export function hashForView(view: View): string {
  return `#/${VIEW_SLUGS[view]}`;
}

/** The id after the view slug (`#/builder/wf-1` → `wf-1`), or null. */
export function hashParam(hash: string): string | null {
  const param = hash.replace(/^#\/?/, '').split('?')[0].split('/')[1];
  return param ? decodeURIComponent(param) : null;
}

const MAX_EVENTS = 1500;
const REFRESH_DEBOUNCE_MS = 600;
const PROJECT_KEY = 'asf.project';

type Connection = 'connecting' | 'live' | 'offline';

interface StudioState {
  view: View;
  info: ServerInfo | null;
  projects: Project[];
  currentProjectId: string | null;
  snapshot: ProjectSnapshot | null;
  events: StudioEvent[];
  providers: ProviderInfo[];
  agentConfigs: AgentConfig[];
  agentTests: Partial<Record<AgentRole, AgentTestResult>>;
  testingAgents: Partial<Record<AgentRole, boolean>>;
  agentTestErrors: Partial<Record<AgentRole, string | null>>;
  testAgent: (role: AgentRole) => Promise<void>;
  selectedRole: AgentRole | null;
  selectedTaskId: string | null;
  messages: Partial<Record<AgentRole, AgentMessage[]>>;
  connection: Connection;
  /** Cross-project live view of every agent that is working right now. */
  live: LiveSnapshot | null;
  refreshLive: () => Promise<void>;
  error: string | null;
  authRequired: boolean;
  leftCollapsed: boolean;
  rightCollapsed: boolean;

  setView: (view: View) => void;
  setError: (error: string | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  init: () => Promise<void>;
  selectProject: (id: string | null) => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshProviders: (force?: boolean) => Promise<void>;
  selectAgent: (role: AgentRole | null) => void;
  selectTask: (id: string | null) => void;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  startPlanning: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancelProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  decide: (approvalId: string, decision: 'approved' | 'rejected', note?: string) => Promise<void>;
  loadMessages: (role: AgentRole) => Promise<void>;
  sendMessage: (role: AgentRole, message: string) => Promise<void>;
  updateProvider: (id: string, body: { enabled?: boolean; budgetUsd?: number | null; settings?: Record<string, string> }) => Promise<void>;
  updateAgentConfig: (role: AgentRole, config: Omit<AgentConfig, 'role'>) => Promise<void>;
  updateSettings: (settings: Partial<StudioSettings>) => Promise<void>;
}

function readHashView(): View {
  return viewFromHash(window.location.hash);
}

function storedProject(): string | null {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}

function upsert<T extends { id: string | number }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const copy = list.slice();
  copy[index] = item;
  return copy;
}

/** Listeners for the V2 session stream (session.* and budget.updated). Output chunks never enter `events`. */
const sessionEventListeners = new Set<(event: StudioEvent) => void>();
export function onSessionEvent(listener: (event: StudioEvent) => void): () => void {
  sessionEventListeners.add(listener);
  return () => { sessionEventListeners.delete(listener); };
}
const isSessionStreamEvent = (type: string): boolean => type.startsWith('session.') || type === 'budget.updated';

let source: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_POLL_MS = 3000;
const LIVE_DEBOUNCE_MS = 400;

export const useStudio = create<StudioState>((set, get) => {
  /** Run an action, surfacing failures as a banner instead of throwing into React. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      set({ error: (error as Error).message });
      return undefined;
    }
  };

  const scheduleRefresh = (): void => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refreshSnapshot();
    }, REFRESH_DEBOUNCE_MS);
  };

  const applyEvent = (event: StudioEvent): void => {
    if (isSessionStreamEvent(event.type)) {
      sessionEventListeners.forEach((listener) => listener(event));
      if (event.type === 'session.output') return;
    }
    const state = get();
    const events = state.events.length >= MAX_EVENTS ? [...state.events.slice(-MAX_EVENTS + 1), event] : [...state.events, event];
    const patchState: Partial<StudioState> = { events };
    const data = event.data ?? {};
    const snap = state.snapshot;
    const forCurrent = snap && event.projectId === snap.project.id;

    if ('task' in data && forCurrent) {
      patchState.snapshot = { ...snap, tasks: upsert(snap.tasks, data.task as Task) };
      scheduleRefresh();
    }
    if (event.type === 'project.deleted' && typeof data.projectId === 'string') {
      const deletedId = data.projectId;
      patchState.projects = state.projects.filter((p) => p.id !== deletedId);
      if (state.currentProjectId === deletedId) setTimeout(() => void get().selectProject(get().projects[0]?.id ?? null), 0);
    }
    if (event.type === 'project.updated' && 'project' in data) {
      const project = data.project as Project;
      patchState.projects = upsert(state.projects, project);
      if (forCurrent) patchState.snapshot = { ...(patchState.snapshot ?? snap), project };
      if (!state.currentProjectId) setTimeout(() => void get().selectProject(project.id), 0);
    }
    if (event.type === 'approval.updated' && 'approval' in data && forCurrent) {
      const base = patchState.snapshot ?? snap;
      patchState.snapshot = { ...base, approvals: upsert(base.approvals, data.approval as Approval) };
    }
    if (event.type === 'agent.message' && 'message' in data && event.role) {
      const message = data.message as AgentMessage;
      if (message.projectId === state.currentProjectId) {
        const current = state.messages[event.role] ?? [];
        patchState.messages = { ...state.messages, [event.role]: upsert(current, message) };
      }
    }
    if (forCurrent && event.type !== 'agent.output' && !isSessionStreamEvent(event.type)) scheduleRefresh();
    if (!liveTimer && (event.type.startsWith('task.') || event.type.startsWith('agent.') || event.type === 'provider.fallback')) {
      liveTimer = setTimeout(() => { liveTimer = null; void get().refreshLive(); }, LIVE_DEBOUNCE_MS);
    }
    if (event.type === 'provider.updated' || event.type === 'agent.config') void get().refreshProviders();
    set(patchState);
  };

  const connect = (): void => {
    source?.close();
    const last = get().events.at(-1)?.id ?? 0;
    set({ connection: 'connecting' });
    source = new EventSource(eventsUrl(last));
    source.onopen = () => set({ connection: 'live' });
    source.onerror = () => set({ connection: source?.readyState === EventSource.CLOSED ? 'offline' : 'connecting' });
    source.addEventListener('studio', (message) => applyEvent(JSON.parse((message as MessageEvent).data) as StudioEvent));
  };

  return {
    view: readHashView(),
    info: null,
    projects: [],
    currentProjectId: null,
    snapshot: null,
    events: [],
    providers: [],
    agentConfigs: [],
    agentTests: {},
    testingAgents: {},
    agentTestErrors: {},
    selectedRole: null,
    selectedTaskId: null,
    messages: {},
    connection: 'connecting',
    live: null,
    error: null,
    authRequired: false,
    leftCollapsed: false,
    rightCollapsed: false,

    setView: (view) => {
      if (window.location.hash !== hashForView(view)) window.location.hash = hashForView(view);
      set({ view });
    },
    setError: (error) => set({ error }),
    toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
    toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),

    init: async () => {
      window.addEventListener('hashchange', () => set({ view: readHashView() }));
      try {
        const info = await api<ServerInfo>('/api/info');
        set({ info, authRequired: info.authRequired });
      } catch (error) {
        if ((error as { status?: number }).status === 401) { set({ authRequired: true }); return; }
        set({ error: `Cannot reach the studio server: ${(error as Error).message}`, connection: 'offline' });
        return;
      }
      await Promise.all([get().refreshProjects(), get().refreshProviders()]);
      const stored = storedProject();
      const projects = get().projects;
      const initial = projects.find((p) => p.id === stored) ?? projects[0];
      if (initial) await get().selectProject(initial.id);
      connect();
      void get().refreshLive();
      setInterval(() => void get().refreshLive(), LIVE_POLL_MS);
    },

    selectProject: async (id) => {
      try { if (id) localStorage.setItem(PROJECT_KEY, id); } catch { /* ignore */ }
      set({ currentProjectId: id, snapshot: null, selectedTaskId: null, messages: {} });
      if (!id) return;
      await get().refreshSnapshot();
    },

    refreshSnapshot: async () => {
      const id = get().currentProjectId;
      if (!id) return;
      const snapshot = await guarded(() => api<ProjectSnapshot>(`/api/projects/${id}`));
      if (!snapshot || get().currentProjectId !== id) return;
      const known = new Set(get().events.map((e) => e.id));
      const merged = [...get().events, ...snapshot.recentEvents.filter((e) => !known.has(e.id))].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS);
      set({ snapshot, events: merged, projects: upsert(get().projects, snapshot.project) });
    },

    refreshProjects: async () => {
      const projects = await guarded(() => api<Project[]>('/api/projects'));
      if (projects) set({ projects });
    },

    refreshProviders: async (force = false) => {
      const [providers, agentConfigs] = await Promise.all([
        guarded(() => api<ProviderInfo[]>(`/api/providers${force ? '?refresh=1' : ''}`)),
        guarded(() => api<AgentConfig[]>('/api/agents/config')),
      ]);
      set({ ...(providers ? { providers } : {}), ...(agentConfigs ? { agentConfigs } : {}) });
    },

    selectAgent: (role) => {
      set({ selectedRole: role, rightCollapsed: false });
      if (role) void get().loadMessages(role);
    },
    selectTask: (id) => set({ selectedTaskId: id, rightCollapsed: false }),

    createProject: async (input) => {
      const project = await post<Project>('/api/projects', input);
      set({ projects: upsert(get().projects, project) });
      await get().selectProject(project.id);
      return project;
    },

    startPlanning: async () => { await guarded(() => post(`/api/projects/${get().currentProjectId}/plan`)); await get().refreshSnapshot(); },
    pause: async () => { await guarded(() => post(`/api/projects/${get().currentProjectId}/pause`)); await get().refreshSnapshot(); },
    resume: async () => { await guarded(() => post(`/api/projects/${get().currentProjectId}/resume`)); await get().refreshSnapshot(); },
    cancelProject: async () => { await guarded(() => post(`/api/projects/${get().currentProjectId}/cancel`)); await get().refreshSnapshot(); },
    deleteProject: async (id) => {
      const result = await guarded(() => post(`/api/projects/${id}/delete`));
      if (result === undefined) return;
      const projects = get().projects.filter((p) => p.id !== id);
      set({ projects });
      if (get().currentProjectId === id) await get().selectProject(projects[0]?.id ?? null);
    },
    retryTask: async (id) => { await guarded(() => post(`/api/tasks/${id}/retry`)); await get().refreshSnapshot(); },
    cancelTask: async (id) => { await guarded(() => post(`/api/tasks/${id}/cancel`)); await get().refreshSnapshot(); },
    decide: async (approvalId, decision, note) => {
      await guarded(() => post(`/api/approvals/${approvalId}/decision`, { decision, note: note || null }));
      await get().refreshSnapshot();
    },

    loadMessages: async (role) => {
      const id = get().currentProjectId;
      if (!id) return;
      const messages = await guarded(() => api<AgentMessage[]>(`/api/projects/${id}/agents/${role}/messages`));
      if (messages) set({ messages: { ...get().messages, [role]: messages } });
    },
    sendMessage: async (role, message) => {
      await guarded(() => post(`/api/projects/${get().currentProjectId}/agents/${role}/messages`, { message }));
    },

    updateProvider: async (id, body) => { await guarded(() => patch(`/api/providers/${id}`, body)); await get().refreshProviders(); },
    updateAgentConfig: async (role, config) => {
      await guarded(() => put(`/api/agents/${role}/config`, config));
      await Promise.all([get().refreshProviders(), get().refreshSnapshot()]);
    },
    testAgent: async (role) => {
      if (get().testingAgents[role]) return;
      set((state) => ({ testingAgents: { ...state.testingAgents, [role]: true },
        agentTestErrors: { ...state.agentTestErrors, [role]: null }, agentTests: { ...state.agentTests, [role]: undefined } }));
      try {
        const result = await post<AgentTestResult>(`/api/agents/${role}/test`, {});
        set((state) => ({ agentTests: { ...state.agentTests, [role]: result } }));
      } catch (error) {
        set((state) => ({ agentTestErrors: { ...state.agentTestErrors, [role]: (error as Error).message } }));
      } finally {
        set((state) => ({ testingAgents: { ...state.testingAgents, [role]: false } }));
      }
    },
    refreshLive: async () => {
      try {
        set({ live: await api<LiveSnapshot>('/api/live') });
      } catch {
        // the connection banner already reports an unreachable server
      }
    },
    updateSettings: async (settings) => {
      const updated = await guarded(() => put<StudioSettings>('/api/settings', settings));
      const info = get().info;
      if (updated && info) set({ info: { ...info, settings: updated } });
    },
  };
});
