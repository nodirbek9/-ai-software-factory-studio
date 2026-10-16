import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, List as ListIcon, Network, Search } from 'lucide-react';
import { AGENT_ROLES, AGENT_ROLE_INFO, type AgentRole, type Run, type StudioEvent, type TaskQuery, type TaskRow, type TaskStatus, type TasksResponse } from '@asf/shared';
import { EmptyState, ErrorState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { listRuns } from '@/features/workflows/workflowsApi';
import { ProgressStrip, STATUS_LABEL, TaskBoard } from '@/features/tasks/TaskBoard';
import { TaskDrawer } from '@/features/tasks/TaskDrawer';
import { TaskList } from '@/features/tasks/TaskList';
import { listTasks } from '@/features/tasks/tasksApi';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const SEARCH_DEBOUNCE_MS = 250;
const LIVE_THROTTLE_MS = 1000;
const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];

type ViewMode = 'board' | 'list';

export interface TaskFilters {
  /** '' = all projects. */
  project: string;
  /** 'active' (each project's current run), 'all', or a run id. */
  run: string;
  role: AgentRole | '';
  status: TaskStatus | '';
}

/** Only set filters are sent; the server treats a missing runId as the active run. */
export function buildTaskQuery(filters: TaskFilters, q: string): TaskQuery {
  const query: TaskQuery = {};
  if (filters.project) query.projectId = filters.project;
  if (filters.run !== 'active') query.runId = filters.run;
  if (filters.role) query.role = filters.role;
  if (filters.status) query.status = filters.status;
  if (q.trim()) query.q = q.trim();
  return query;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------ data hooks

/** Fetches the tasks for `query`; `reload` re-fetches in place (live updates keep the data on screen). */
function useTaskData(query: TaskQuery) {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    try {
      const result = await listTasks(queryRef.current);
      if (id !== seq.current) return;
      setData(result);
      setError(null);
      setVersion((n) => n + 1);
    } catch (reason) {
      if (id === seq.current) setError(errorText(reason));
    }
  }, []);

  const key = JSON.stringify(query);
  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
    return () => { seq.current += 1; };
  }, [key, reload]);

  return { data, error, version, reload };
}

function useProjectRuns(projectId: string): { runs: Run[]; reload: () => void } {
  const [runs, setRuns] = useState<Run[]>([]);
  const reload = useCallback(() => {
    if (!projectId) { setRuns([]); return; }
    listRuns(projectId).then((page) => setRuns(page.runs), () => setRuns([]));
  }, [projectId]);
  useEffect(() => { setRuns([]); reload(); }, [reload]);
  return { runs, reload };
}

/** Re-fetches at most once a second when a task or run event of the filtered project arrives on the SSE stream. */
function useLiveRefresh(projectId: string, onTasks: () => void, onRuns: () => void): void {
  const handlers = useRef({ projectId, onTasks, onRuns });
  handlers.current = { projectId, onTasks, onRuns };

  useEffect(() => {
    let seen = useStudio.getState().events.at(-1)?.id ?? 0;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let runsDirty = false;
    const fire = () => {
      timer = null;
      last = Date.now();
      handlers.current.onTasks();
      if (runsDirty) { runsDirty = false; handlers.current.onRuns(); }
    };
    const handle = (event: StudioEvent) => {
      const isRun = event.type.startsWith('run.');
      if (!isRun && event.type !== 'task.updated') return;
      const filter = handlers.current.projectId;
      if (filter && event.projectId && event.projectId !== filter) return;
      if (isRun) runsDirty = true;
      if (!timer) timer = setTimeout(fire, Math.max(0, LIVE_THROTTLE_MS - (Date.now() - last)));
    };
    const unsubscribe = useStudio.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const fresh = state.events.filter((event) => event.id > seen);
      for (const event of fresh) seen = Math.max(seen, event.id);
      fresh.forEach(handle);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, []);
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ------------------------------------------------------------------ toolbar

function ViewSwitch({ view, onChange }: { view: ViewMode; onChange: (view: ViewMode) => void }) {
  const items: { id: ViewMode; label: string; icon: typeof LayoutGrid }[] = [{ id: 'board', label: 'Board', icon: LayoutGrid }, { id: 'list', label: 'List', icon: ListIcon }];
  return (
    <div role="group" aria-label="View" className="inline-flex rounded-md border border-line bg-ink-950 p-0.5">
      {items.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" aria-pressed={view === id} onClick={() => onChange(id)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors', view === id ? 'bg-brand/20 text-text' : 'text-muted hover:text-text')}>
          <Icon size={13} aria-hidden="true" />{label}
        </button>
      ))}
    </div>
  );
}

interface ToolbarProps {
  view: ViewMode;
  onView: (view: ViewMode) => void;
  filters: TaskFilters;
  onFilters: (patch: Partial<TaskFilters>) => void;
  search: string;
  onSearch: (value: string) => void;
  showCancelled: boolean;
  onShowCancelled: (value: boolean) => void;
  runs: Run[];
}

function Toolbar({ view, onView, filters, onFilters, search, onSearch, showCancelled, onShowCancelled, runs }: ToolbarProps) {
  const projects = useStudio((s) => s.projects);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
      <h1 className="mr-2 text-base font-semibold">Tasks</h1>
      <ViewSwitch view={view} onChange={onView} />
      <Select aria-label="Project" className="w-40" value={filters.project} onChange={(e) => onFilters({ project: e.target.value, run: 'active' })}>
        <option value="">All projects</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select>
      <Select aria-label="Run" className="w-36" value={filters.run} onChange={(e) => onFilters({ run: e.target.value })}>
        <option value="active">Active run</option>
        <option value="all">All runs</option>
        {filters.project && runs.map((run) => <option key={run.id} value={run.id}>Run #{run.number}</option>)}
      </Select>
      <Select aria-label="Role" className="w-32" value={filters.role} onChange={(e) => onFilters({ role: e.target.value as AgentRole | '' })}>
        <option value="">All roles</option>
        {AGENT_ROLES.map((role) => <option key={role} value={role}>{AGENT_ROLE_INFO[role].name}</option>)}
      </Select>
      <Select aria-label="Status" className="w-36" value={filters.status} onChange={(e) => onFilters({ status: e.target.value as TaskStatus | '' })}>
        <option value="">All statuses</option>
        {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
      </Select>
      <div className="relative w-48">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" aria-hidden="true" />
        <Input aria-label="Search tasks" className="pl-8" placeholder="Search tasks" value={search} onChange={(e) => onSearch(e.target.value)} />
      </div>
      <label className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
        <input type="checkbox" checked={showCancelled} onChange={(e) => onShowCancelled(e.target.checked)} />Show cancelled
      </label>
      <a href="#/board" className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] text-brand-2 hover:underline">
        <Network size={13} aria-hidden="true" />Open task graph
      </a>
    </div>
  );
}

// ------------------------------------------------------------------ page

function BodySkeleton() {
  return (
    <div className="flex gap-3 p-4" aria-busy="true" aria-label="Loading tasks">
      {[0, 1, 2, 3].map((n) => <Skeleton key={n} className="h-64 w-64 shrink-0" />)}
    </div>
  );
}

function Body({ tasks, truncated, hasFilters, ...rest }: { tasks: TaskRow[]; truncated: boolean; hasFilters: boolean; view: ViewMode; showCancelled: boolean; showProject: boolean; selectedId: string | null; onOpen: (id: string) => void }) {
  if (tasks.length === 0) {
    return (
      <EmptyState title={hasFilters ? 'No tasks match these filters' : 'No tasks yet'}>
        {hasFilters ? 'Clear a filter or widen the run selection.' : 'Tasks appear here once a run is started for a project.'}
      </EmptyState>
    );
  }
  return (
    <>
      {truncated && <p role="status" className="border-b border-line-soft px-4 py-1.5 text-[12px] text-st-waiting">More tasks matched than are shown. Narrow the filters to see the rest.</p>}
      <ProgressStrip tasks={tasks} />
      {rest.view === 'board'
        ? <TaskBoard tasks={tasks} showCancelled={rest.showCancelled} showProject={rest.showProject} selectedId={rest.selectedId} onOpen={rest.onOpen} />
        : <TaskList tasks={tasks} showProject={rest.showProject} selectedId={rest.selectedId} onOpen={rest.onOpen} />}
    </>
  );
}

export default function Tasks() {
  const headerProject = useStudio((s) => s.currentProjectId) ?? '';
  const [view, setView] = useState<ViewMode>('board');
  const [filters, setFilters] = useState<TaskFilters>({ project: headerProject, run: 'active', role: '', status: '' });
  const [search, setSearch] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);

  // The header project selector is the default; picking another project there moves this page along.
  useEffect(() => { setFilters((current) => (current.project === headerProject ? current : { ...current, project: headerProject, run: 'active' })); }, [headerProject]);

  const query = useMemo(() => buildTaskQuery(filters, q), [filters, q]);
  const { data, error, version, reload } = useTaskData(query);
  const { runs, reload: reloadRuns } = useProjectRuns(filters.project);
  useLiveRefresh(filters.project, () => void reload(), reloadRuns);

  const patchFilters = (patch: Partial<TaskFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const visible = useMemo(
    () => (data ? data.tasks.filter((task) => showCancelled || filters.status === 'cancelled' || task.status !== 'cancelled') : []),
    [data, showCancelled, filters.status],
  );
  const hasFilters = Boolean(filters.run !== 'active' || filters.role || filters.status || q.trim());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar view={view} onView={setView} filters={filters} onFilters={patchFilters} search={search} onSearch={setSearch}
        showCancelled={showCancelled} onShowCancelled={setShowCancelled} runs={runs} />
      {error && data && <p role="alert" className="border-b border-st-failed/30 bg-st-failed/10 px-4 py-1.5 text-[12.5px] text-st-failed">Could not refresh tasks: {error}</p>}
      <div className="flex min-h-0 flex-1 flex-col">
        {error && !data && <ErrorState title="Could not load tasks" message={error} onRetry={() => void reload()} />}
        {!error && !data && <BodySkeleton />}
        {data && <Body tasks={visible} truncated={data.truncated} hasFilters={hasFilters} view={view} showCancelled={showCancelled}
          showProject={!filters.project} selectedId={selectedId} onOpen={setSelectedId} />}
      </div>
      {selectedId && <TaskDrawer taskId={selectedId} refreshKey={version} onClose={() => setSelectedId(null)} onChanged={() => void reload()} />}
    </div>
  );
}
