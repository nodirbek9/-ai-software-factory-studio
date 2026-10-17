import { create } from 'zustand';
import type {
  NodeCatalogEntry, Run, RunStatus, RunTimeline, RunsPage, SimulationResult, StudioEvent, Task, ValidationResult, Workflow,
  WorkflowGraph, WorkflowNodeType, WorkflowSummary,
} from '@asf/shared';
import { useStudio } from '@/store/studio';
import { layoutGraph } from './autoLayout';
import { HISTORY_LIMIT, addNode, createEditorState, markSaved, parseWorkflowJson, redo, select, undo, type EditorState } from './graphState';
import * as wf from './workflowsApi';

/** Autosave fires this long after the last edit (WORKFLOW_ENGINE_SPEC.md §9). */
export const AUTOSAVE_DELAY_MS = 5000;
/** The run timeline is re-read at most once per second while task events stream in. */
export const TIMELINE_THROTTLE_MS = 1000;
const RUNS_THROTTLE_MS = 500;

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['planning', 'running', 'awaiting_approval', 'paused'];
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };

export interface SaveInfo {
  kind: 'manual' | 'auto';
  /** hh:mm */
  at: string;
}

export interface WorkflowsState {
  projectId: string | null;
  catalog: NodeCatalogEntry[];
  catalogLoaded: boolean;
  workflows: WorkflowSummary[];
  listStatus: 'idle' | 'loading' | 'ready' | 'error';
  listError: string | null;
  current: Workflow | null;
  editor: EditorState | null;
  loadingWorkflow: boolean;
  workflowError: string | null;
  validation: ValidationResult | null;
  validating: boolean;
  simulation: SimulationResult | null;
  simulating: boolean;
  runs: Run[];
  runsNext: number | null;
  runsLoaded: boolean;
  runsError: string | null;
  loadingMoreRuns: boolean;
  selectedRunId: string | null;
  timeline: RunTimeline | null;
  timelineError: string | null;
  saving: boolean;
  saveInfo: SaveInfo | null;
  saveError: string | null;
  starting: boolean;
  /** The last failed toolbar/panel action; shown as a dismissible banner. */
  actionError: string | null;

  open: (projectId: string, preferredId?: string | null) => Promise<void>;
  reset: () => void;
  selectWorkflow: (id: string | null) => Promise<void>;
  edit: (editor: EditorState) => void;
  undo: () => void;
  redo: () => void;
  autoLayout: () => void;
  addNodeOfType: (type: WorkflowNodeType) => void;
  focusNode: (nodeId: string) => void;
  validate: () => Promise<void>;
  simulate: () => Promise<void>;
  save: (kind?: SaveInfo['kind']) => Promise<void>;
  createWorkflow: (name: string) => Promise<void>;
  duplicate: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  archive: () => Promise<void>;
  importText: (text: string) => Promise<void>;
  exportJson: () => Promise<{ name: string; json: string } | null>;
  refreshRuns: () => Promise<void>;
  loadMoreRuns: () => Promise<void>;
  selectRun: (runId: string | null) => Promise<void>;
  refreshTimeline: () => Promise<void>;
  startRun: () => Promise<Run | null>;
  cancelRun: (runId: string) => Promise<void>;
  dismissActionError: () => void;
}

// ------------------------------------------------------------------ pure helpers

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function clock(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export const activeRunOf = (runs: Run[]): Run | null => runs.find((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;

export function toSummary(workflow: Workflow): WorkflowSummary {
  const { id, projectId, name, description, version, builtin, archived, createdAt, updatedAt } = workflow;
  return { id, projectId, name, description, version, builtin, archived, nodeCount: workflow.graph.nodes.length, createdAt, updatedAt };
}

function upsertSummary(list: WorkflowSummary[], summary: WorkflowSummary): WorkflowSummary[] {
  const index = list.findIndex((item) => item.id === summary.id);
  if (index === -1) return [...list, summary];
  const copy = list.slice();
  copy[index] = summary;
  return copy;
}

/** The first page is replaced; older pages the user already loaded stay. */
function mergeRuns(prev: Run[], prevNext: number | null, page: RunsPage): { runs: Run[]; next: number | null } {
  if (page.runs.length === 0) return { runs: prev, next: prevNext };
  const floor = Math.min(...page.runs.map((run) => run.number));
  const older = prev.filter((run) => run.number < floor);
  return { runs: [...page.runs, ...older], next: older.length > 0 ? prevNext : page.nextBefore };
}

/** Where a palette-added node goes: under the existing graph, aligned with its left edge. */
function nextNodePosition(graph: WorkflowGraph): { x: number; y: number } {
  if (graph.nodes.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...graph.nodes.map((node) => node.position.x)),
    y: Math.max(...graph.nodes.map((node) => node.position.y)) + 130,
  };
}

/** Auto-layout as one undoable change (graphState.replaceGraph would clear the history). */
export function applyAutoLayout(state: EditorState): EditorState {
  const graph = layoutGraph(state.graph);
  const moved = graph.nodes.some((node, i) => node.position.x !== state.graph.nodes[i].position.x || node.position.y !== state.graph.nodes[i].position.y);
  if (!moved) return state;
  const past = [...state.past, state.dragBase ?? state.graph];
  return { ...state, graph, past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, future: [], dirty: true, dragBase: undefined };
}

/** Why the Run button is disabled, or null when a run can start. */
export function runBlockReason(
  s: Pick<WorkflowsState, 'projectId' | 'current' | 'editor' | 'validation' | 'validating' | 'runs' | 'saving' | 'starting'>,
): string | null {
  if (!s.projectId) return 'Select a project first.';
  if (!s.current) return 'Choose a workflow first.';
  if (s.editor?.dirty && !s.current.builtin) return 'Unsaved changes — save the workflow first (Ctrl+S).';
  if (s.saving) return 'Saving the workflow…';
  const active = activeRunOf(s.runs);
  if (active) return `Run #${active.number} is still ${active.status.replace('_', ' ')}. Wait for it to finish or cancel it.`;
  if (s.starting) return 'Starting the run…';
  if (s.validating) return 'Validating the workflow…';
  if (!s.validation) return 'Validate the workflow first.';
  if (!s.validation.ok) {
    const count = s.validation.errors.length;
    return `${count} validation ${count === 1 ? 'error' : 'errors'} — fix ${count === 1 ? 'it' : 'them'} first (see Validation).`;
  }
  return null;
}

// ------------------------------------------------------------------ module-level timers (not reactive)

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let openToken = 0;
let workflowToken = 0;

function createThrottle(run: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; last = Date.now(); run(); };
  return {
    schedule() {
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// The callbacks run after the store exists, so referring to `useWorkflows` here is safe.
const runsThrottle = createThrottle(() => { void useWorkflows.getState().refreshRuns(); }, RUNS_THROTTLE_MS);
const timelineThrottle = createThrottle(() => { void useWorkflows.getState().refreshTimeline(); }, TIMELINE_THROTTLE_MS);

const clearAutosave = () => {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = null;
};

const INITIAL = {
  workflows: [] as WorkflowSummary[], listStatus: 'idle' as const, listError: null, current: null, editor: null, loadingWorkflow: false,
  workflowError: null, validation: null, validating: false, simulation: null, simulating: false, runs: [] as Run[], runsNext: null,
  runsLoaded: false, runsError: null, loadingMoreRuns: false, selectedRunId: null, timeline: null, timelineError: null, saving: false,
  saveInfo: null, saveError: null, starting: false, actionError: null,
};

export const useWorkflows = create<WorkflowsState>((set, get) => {
  /** Run a user action; a failure becomes the dismissible banner instead of an unhandled rejection. */
  const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (cause) {
      set({ actionError: errorMessage(cause) });
      return undefined;
    }
  };

  const scheduleAutosave = () => {
    clearAutosave();
    const { editor, current } = get();
    if (!editor?.dirty || !current || current.builtin) return;
    autosaveTimer = setTimeout(() => { void get().save('auto'); }, AUTOSAVE_DELAY_MS);
  };

  /** Saves pending edits before the editor switches to another workflow. */
  const flush = async () => {
    if (get().editor?.dirty && !get().current?.builtin) await get().save('auto');
  };

  const loadWorkflow = async (id: string) => {
    clearAutosave();
    workflowToken += 1;
    const token = workflowToken;
    set({ loadingWorkflow: true, workflowError: null, validation: null, simulation: null });
    try {
      const workflow = await wf.getWorkflow(id);
      if (token !== workflowToken) return;
      set({ current: workflow, editor: createEditorState(workflow.graph), loadingWorkflow: false, saveInfo: null, saveError: null });
      void get().validate();
    } catch (cause) {
      if (token !== workflowToken) return;
      set({ loadingWorkflow: false, workflowError: errorMessage(cause) });
    }
  };

  const adopt = async (workflow: Workflow) => {
    set((s) => ({ workflows: upsertSummary(s.workflows, toSummary(workflow)) }));
    await loadWorkflow(workflow.id);
  };

  return {
    projectId: null,
    catalog: [],
    catalogLoaded: false,
    ...INITIAL,

    open: async (projectId, preferredId = null) => {
      const token = ++openToken;
      const sameProject = get().projectId === projectId;
      if (!sameProject) {
        await flush();
        clearAutosave();
        workflowToken += 1;
        set({ ...INITIAL, projectId });
      }
      set({ listStatus: 'loading', listError: null });
      const [list, catalog] = await Promise.allSettled([
        wf.listWorkflows(projectId),
        get().catalogLoaded ? Promise.resolve(get().catalog) : wf.getCatalog(),
      ]);
      if (token !== openToken) return;
      if (list.status === 'rejected' || catalog.status === 'rejected') {
        const reason = list.status === 'rejected' ? list.reason : (catalog as PromiseRejectedResult).reason;
        set({ listStatus: 'error', listError: errorMessage(reason) });
        return;
      }
      const workflows = list.value.filter((item) => !item.archived);
      set({ workflows, catalog: catalog.value, catalogLoaded: true, listStatus: 'ready' });
      void get().refreshRuns();

      const keep = get().current;
      if (keep && workflows.some((item) => item.id === keep.id) && (!preferredId || preferredId === keep.id)) return;
      const target = workflows.find((item) => item.id === preferredId) ?? workflows.find((item) => !item.builtin) ?? workflows[0];
      if (target) await loadWorkflow(target.id);
    },

    reset: () => {
      clearAutosave();
      runsThrottle.cancel();
      timelineThrottle.cancel();
      openToken += 1;
      workflowToken += 1;
      set({ ...INITIAL, projectId: null });
    },

    selectWorkflow: async (id) => {
      if (id === get().current?.id) return;
      await flush();
      if (id) {
        await loadWorkflow(id);
        return;
      }
      clearAutosave();
      workflowToken += 1;
      set({ current: null, editor: null, validation: null, simulation: null, workflowError: null, saveInfo: null });
    },

    edit: (editor) => {
      const previous = get().editor;
      if (!previous || previous === editor) return;
      if (editor.graph === previous.graph) {
        set({ editor });
        return;
      }
      set({ editor, validation: null, simulation: null });
      scheduleAutosave();
    },

    undo: () => { const editor = get().editor; if (editor) get().edit(undo(editor)); },
    redo: () => { const editor = get().editor; if (editor) get().edit(redo(editor)); },
    autoLayout: () => { const editor = get().editor; if (editor && !get().current?.builtin) get().edit(applyAutoLayout(editor)); },

    addNodeOfType: (type) => {
      const { editor, catalog, current } = get();
      if (!editor || !current || current.builtin) return;
      get().edit(addNode(editor, type, nextNodePosition(editor.graph), catalog));
    },

    focusNode: (nodeId) => {
      const editor = get().editor;
      if (editor) set({ editor: select(editor, [nodeId]) });
    },

    validate: async () => {
      const { editor, current } = get();
      if (!editor || !current) return;
      const graph = editor.graph;
      set({ validating: true });
      try {
        const validation = await wf.validateWorkflow(graph);
        if (get().editor?.graph === graph) set({ validation, validating: false });
        else set({ validating: false });
      } catch (cause) {
        set({ validating: false, validation: null, actionError: `Validation failed: ${errorMessage(cause)}` });
      }
    },

    simulate: async () => {
      if (get().editor?.dirty && !get().current?.builtin) {
        await get().save('manual');
        if (get().editor?.dirty) return;
      }
      const current = get().current;
      if (!current) return;
      set({ simulating: true });
      try {
        const simulation = await wf.simulateWorkflow(current.id);
        if (get().current?.id === current.id) set({ simulation, validation: simulation.validation, simulating: false });
        else set({ simulating: false });
      } catch (cause) {
        set({ simulating: false, actionError: `Simulation failed: ${errorMessage(cause)}` });
      }
    },

    save: async (kind = 'manual') => {
      clearAutosave();
      const { current, editor, saving } = get();
      if (!current || !editor || current.builtin || !editor.dirty || saving) return;
      const graph = editor.graph;
      set({ saving: true, saveError: null });
      try {
        const saved = await wf.saveWorkflow(current.id, { name: current.name, description: current.description, graph });
        if (get().current?.id !== saved.id) { set({ saving: false }); return; }
        const latest = get().editor;
        set((s) => ({
          current: saved, saving: false, saveInfo: { kind, at: clock() }, workflows: upsertSummary(s.workflows, toSummary(saved)),
          editor: latest && latest.graph === graph ? markSaved(latest) : latest,
        }));
        scheduleAutosave();
        void get().validate();
      } catch (cause) {
        set({ saving: false, saveError: errorMessage(cause) });
      }
    },

    createWorkflow: async (name) => {
      const projectId = get().projectId;
      if (!projectId) return;
      await flush();
      const graph = addNode(createEditorState(EMPTY_GRAPH), 'trigger', { x: 0, y: 0 }, get().catalog).graph;
      const created = await attempt(() => wf.createWorkflow({ name, description: '', projectId, graph }));
      if (created) await adopt(created);
    },

    duplicate: async () => {
      const current = get().current;
      if (!current) return;
      await flush();
      const copy = await attempt(() => wf.duplicateWorkflow(current.id));
      if (copy) await adopt(copy);
    },

    rename: async (name) => {
      const { current, editor } = get();
      if (!current || current.builtin || !name.trim() || name === current.name) return;
      const saved = await attempt(() => wf.saveWorkflow(current.id, { name: name.trim(), description: current.description, graph: editor?.graph ?? current.graph }));
      if (!saved || get().current?.id !== saved.id) return;
      const latest = get().editor;
      set((s) => ({
        current: saved, workflows: upsertSummary(s.workflows, toSummary(saved)), saveInfo: { kind: 'manual', at: clock() },
        editor: latest && latest.graph === (editor?.graph ?? current.graph) ? markSaved(latest) : latest,
      }));
    },

    archive: async () => {
      const current = get().current;
      if (!current || current.builtin) return;
      const done = await attempt(async () => { await wf.archiveWorkflow(current.id); return true; });
      if (!done) return;
      clearAutosave();
      const workflows = get().workflows.filter((item) => item.id !== current.id);
      set({ workflows, current: null, editor: null, validation: null, simulation: null });
      const next = workflows.find((item) => !item.builtin) ?? workflows[0];
      if (next) await loadWorkflow(next.id);
    },

    importText: async (text) => {
      const projectId = get().projectId;
      if (!projectId) return;
      const parsed = parseWorkflowJson(text);
      if ('error' in parsed) { set({ actionError: `Import failed: ${parsed.error}` }); return; }
      await flush();
      const imported = await attempt(() => wf.importWorkflow(JSON.parse(text) as unknown, projectId));
      if (imported) await adopt(imported);
    },

    exportJson: async () => {
      const { current, editor } = get();
      if (!current) return null;
      const data = editor?.dirty && !current.builtin
        ? { name: current.name, description: current.description, graph: editor.graph }
        : await attempt(() => wf.exportWorkflow(current.id));
      return data ? { name: current.name, json: JSON.stringify(data, null, 2) } : null;
    },

    refreshRuns: async () => {
      const projectId = get().projectId;
      if (!projectId) return;
      try {
        const page = await wf.listRuns(projectId);
        if (get().projectId !== projectId) return;
        const merged = mergeRuns(get().runs, get().runsNext, page);
        set({ runs: merged.runs, runsNext: merged.next, runsLoaded: true, runsError: null });
        if (!get().selectedRunId && merged.runs.length > 0) await get().selectRun((activeRunOf(merged.runs) ?? merged.runs[0]).id);
      } catch (cause) {
        set({ runsLoaded: true, runsError: errorMessage(cause) });
      }
    },

    loadMoreRuns: async () => {
      const { projectId, runsNext, loadingMoreRuns } = get();
      if (!projectId || runsNext === null || loadingMoreRuns) return;
      set({ loadingMoreRuns: true });
      try {
        const page = await wf.listRuns(projectId, runsNext);
        if (get().projectId !== projectId) return;
        const known = new Set(get().runs.map((run) => run.id));
        set({ runs: [...get().runs, ...page.runs.filter((run) => !known.has(run.id))], runsNext: page.nextBefore, loadingMoreRuns: false });
      } catch (cause) {
        set({ loadingMoreRuns: false, runsError: errorMessage(cause) });
      }
    },

    selectRun: async (runId) => {
      if (runId !== get().selectedRunId) set({ selectedRunId: runId, timeline: null, timelineError: null });
      if (runId) await get().refreshTimeline();
    },

    refreshTimeline: async () => {
      const runId = get().selectedRunId;
      if (!runId) return;
      try {
        const timeline = await wf.getRunTimeline(runId);
        if (get().selectedRunId === runId) set({ timeline, timelineError: null });
      } catch (cause) {
        if (get().selectedRunId === runId) set({ timelineError: errorMessage(cause) });
      }
    },

    startRun: async () => {
      const state = get();
      if (runBlockReason(state) || !state.projectId || !state.current) return null;
      set({ starting: true, actionError: null });
      const run = await attempt(() => wf.startRun(state.projectId as string, (state.current as Workflow).id));
      set({ starting: false });
      if (!run) return null;
      set((s) => ({ runs: [run, ...s.runs.filter((item) => item.id !== run.id)] }));
      await get().selectRun(run.id);
      void get().refreshRuns();
      void useStudio.getState().refreshSnapshot();
      return run;
    },

    cancelRun: async (runId) => {
      const done = await attempt(async () => { await wf.cancelRun(runId); return true; });
      if (!done) return;
      await Promise.all([get().refreshRuns(), get().refreshTimeline()]);
      void useStudio.getState().refreshSnapshot();
    },

    dismissActionError: () => set({ actionError: null }),
  };
});

// ------------------------------------------------------------------ live events (run.* and task.*)

const runIdOf = (data: StudioEvent['data']): string | null => {
  const run = data?.run as { id?: unknown } | undefined;
  if (typeof run?.id === 'string') return run.id;
  return typeof data?.runId === 'string' ? data.runId : null;
};

/** Applies one SSE event. Exported for tests; the page subscribes through `attachStudioEvents`. */
export function handleStudioEvent(event: StudioEvent): void {
  const state = useWorkflows.getState();
  if (!state.projectId || (event.projectId && event.projectId !== state.projectId)) return;
  if (event.type === 'run.created' || event.type === 'run.updated') {
    runsThrottle.schedule();
    const runId = runIdOf(event.data);
    if (runId && runId === state.selectedRunId) timelineThrottle.schedule();
    return;
  }
  if (event.type === 'task.updated') {
    const task = event.data?.task as Task | undefined;
    if (task?.runId && task.runId === state.selectedRunId) timelineThrottle.schedule();
  }
}

/** Feeds new studio events (the SSE stream already merged into the studio store) to the builder. Returns the unsubscribe. */
export function attachStudioEvents(): () => void {
  let seen = useStudio.getState().events.at(-1)?.id ?? 0;
  return useStudio.subscribe((state, previous) => {
    if (state.events === previous.events) return;
    const fresh = state.events.filter((event) => event.id > seen);
    for (const event of fresh) seen = Math.max(seen, event.id);
    fresh.forEach(handleStudioEvent);
  });
}
