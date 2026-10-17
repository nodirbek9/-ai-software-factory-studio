import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, ProjectSnapshot, Run, Task, TaskStatus } from '@asf/shared';
import { ExternalLink } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { Button, EmptyState, ErrorState, Panel, Progress, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { activeRunOf } from '@/features/workflows/workflowsStore';
import { RunStatusPill, formatCost, formatMs } from '@/features/workflows/RunPanel';
import { cn, formatDuration, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { ProjectFiles } from '@/pages/Files';
import { getInstallScripts, getReport, setInstallScripts } from './projectsApi';

export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'requirements', label: 'Requirements' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'plan', label: 'Plan' },
  { id: 'runs', label: 'Runs' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'files', label: 'Files' },
  { id: 'report', label: 'Report' },
  { id: 'settings', label: 'Settings' },
] as const;
export type ProjectTabId = (typeof PROJECT_TABS)[number]['id'];

const SPEC_EXCERPT_CHARS = 600;
const EVENT_THROTTLE_MS = 1000;
const WORKSPACE_MODE_LABELS = { new: 'New empty workspace', sample: 'Sample project', import: 'Imported repository' } as const;
const TASK_STATUS_ORDER: TaskStatus[] = ['completed', 'running', 'waiting_approval', 'ready', 'pending', 'blocked', 'failed', 'cancelled'];

export const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : 'Something went wrong.');

// ------------------------------------------------------------------ data hooks

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-fetches without clearing the data on screen. */
  reload: () => void;
}

/** Loads once per `load` identity (wrap it in useCallback); late replies of an outdated request are dropped. */
export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const sequence = useRef(0);
  const run = useCallback((initial: boolean) => {
    const id = ++sequence.current;
    setState((prev) => ({ data: initial ? null : prev.data, error: null, loading: true }));
    load().then(
      (data) => { if (id === sequence.current) setState({ data, error: null, loading: false }); },
      (cause: unknown) => { if (id === sequence.current) setState((prev) => ({ data: prev.data, error: errorMessage(cause), loading: false })); },
    );
  }, [load]);
  useEffect(() => {
    run(true);
    return () => { sequence.current++; };
  }, [run]);
  const reload = useCallback(() => run(false), [run]);
  return { ...state, reload };
}

const refreshesProject = (type: string): boolean => type === 'project.updated' || type === 'task.updated' || type.startsWith('run.');

/** Calls `onChange` (at most once a second, trailing) when the SSE stream reports a change of this project. */
export function useProjectEvents(projectId: string, onChange: () => void): void {
  const callback = useRef(onChange);
  useEffect(() => { callback.current = onChange; });
  useEffect(() => {
    let seen = useStudio.getState().events.at(-1)?.id ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useStudio.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const fresh = state.events.filter((event) => event.id > seen);
      for (const event of fresh) seen = Math.max(seen, event.id);
      if (timer || !fresh.some((event) => event.projectId === projectId && refreshesProject(event.type))) return;
      timer = setTimeout(() => { timer = null; callback.current(); }, EVENT_THROTTLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
}

export interface RunsState {
  runs: Run[];
  next: number | null;
  loaded: boolean;
  error: string | null;
  loadingMore: boolean;
  reload: () => void;
  loadMore: () => void;
}

/** Newest-first runs of a project: the first page plus any "load more" pages the user opened. */
export function useRuns(projectId: string, fetchPage: (projectId: string, before?: number) => Promise<{ runs: Run[]; nextBefore: number | null }>): RunsState {
  const [state, setState] = useState({ runs: [] as Run[], next: null as number | null, loaded: false, error: null as string | null, loadingMore: false });
  const sequence = useRef(0);

  const reload = useCallback(() => {
    const id = ++sequence.current;
    fetchPage(projectId).then((page) => {
      if (id !== sequence.current) return;
      if (page.runs.length === 0) { setState((prev) => ({ ...prev, runs: [], next: null, loaded: true, error: null })); return; }
      setState((prev) => {
        const floor = Math.min(...page.runs.map((run) => run.number));
        const older = prev.runs.filter((run) => run.number < floor);
        return { ...prev, runs: [...page.runs, ...older], next: older.length ? prev.next : page.nextBefore, loaded: true, error: null };
      });
    }, (cause: unknown) => {
      if (id === sequence.current) setState((prev) => ({ ...prev, loaded: true, error: errorMessage(cause) }));
    });
  }, [projectId, fetchPage]);

  const loadMore = useCallback(() => {
    const before = state.next;
    if (before === null || state.loadingMore) return;
    const id = sequence.current;
    setState((prev) => ({ ...prev, loadingMore: true }));
    fetchPage(projectId, before).then((page) => {
      if (id !== sequence.current) return;
      setState((prev) => {
        const known = new Set(prev.runs.map((run) => run.id));
        return { ...prev, runs: [...prev.runs, ...page.runs.filter((run) => !known.has(run.id))], next: page.nextBefore, loadingMore: false };
      });
    }, (cause: unknown) => {
      if (id === sequence.current) setState((prev) => ({ ...prev, loadingMore: false, error: errorMessage(cause) }));
    });
  }, [projectId, fetchPage, state.next, state.loadingMore]);

  useEffect(() => {
    setState({ runs: [], next: null, loaded: false, error: null, loadingMore: false });
    reload();
    return () => { sequence.current++; };
  }, [reload]);

  return { ...state, reload, loadMore };
}

// ------------------------------------------------------------------ helpers

/** The run the page describes: the active one, else the newest. */
export const currentRunOf = (runs: Run[]): Run | null => activeRunOf(runs) ?? runs[0] ?? null;

/** Tasks of one run in plan order; without runs (nothing recorded yet) every task the snapshot holds. */
export function runTasks(tasks: Task[], run: Run | null): Task[] {
  const list = run ? tasks.filter((task) => task.runId === run.id) : tasks;
  return list.slice().sort((a, b) => a.orderIndex - b.orderIndex);
}

export function lastActivityAt(snapshot: ProjectSnapshot): string {
  const times = [snapshot.project.updatedAt, ...snapshot.tasks.map((task) => task.updatedAt), ...snapshot.recentEvents.map((event) => event.createdAt)];
  return times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
      {children}
    </section>
  );
}

function Loading({ label }: { label: string }) {
  return <div className="space-y-2" aria-busy="true" aria-label={label}><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-3/4" /></div>;
}

function MarkdownTab({ text, emptyTitle, emptyText }: { text: string | null; emptyTitle: string; emptyText: string }) {
  if (!text?.trim()) return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>;
  return <Markdown className="break-words">{text}</Markdown>;
}

// ------------------------------------------------------------------ tab bodies

function TaskBreakdown({ tasks }: { tasks: Task[] }) {
  const counts = TASK_STATUS_ORDER.map((status) => ({ status, count: tasks.filter((task) => task.status === status).length })).filter((item) => item.count > 0);
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Tasks by status">
      {counts.map(({ status, count }) => <li key={status} className="flex items-center gap-1.5"><StatusBadge status={status} /><span className="text-[12px] text-muted">{count}</span></li>)}
    </ul>
  );
}

function OverviewTab({ snapshot, run }: { snapshot: ProjectSnapshot; run: Run | null }) {
  const { project } = snapshot;
  const tasks = runTasks(snapshot.tasks, run);
  const done = tasks.filter((task) => task.status === 'completed').length;
  const problems = tasks.filter((task) => task.error && (task.status === 'failed' || task.status === 'blocked'));
  const spec = project.spec.trim();
  return (
    <div className="space-y-5">
      <Section title="Specification">
        {spec ? (
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted">
            {spec.length > SPEC_EXCERPT_CHARS ? `${spec.slice(0, SPEC_EXCERPT_CHARS).trimEnd()}…` : spec}
          </p>
        ) : <p className="text-[13px] text-muted">This project has no saved specification.</p>}
      </Section>
      <Section title="Progress">
        {tasks.length === 0 ? <p className="text-[13px] text-muted">No tasks yet{run ? ` in run #${run.number}` : ''}. They appear once a run has planned its work.</p> : (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Progress value={done / tasks.length} className="flex-1" />
              <span className="shrink-0 text-[12px] text-muted">{done} / {tasks.length} tasks completed</span>
            </div>
            <TaskBreakdown tasks={tasks} />
            {run && <p className="text-[12px] text-faint">Run #{run.number} · {run.workflowName} · <RunStatusPill status={run.status} /></p>}
          </div>
        )}
      </Section>
      <Section title="Last activity">
        <p className="text-[13px] text-muted" title={lastActivityAt(snapshot)}>{timeAgo(lastActivityAt(snapshot))}</p>
      </Section>
      <Section title="Errors">
        {problems.length === 0 && !run?.errorSummary ? <p className="text-[13px] text-muted">No task errors.</p> : (
          <ul className="space-y-1.5">
            {run?.errorSummary && <li role="alert" className="text-[12.5px] text-st-failed">Run #{run.number}: {run.errorSummary}</li>}
            {problems.map((task) => (
              <li key={task.id} className="text-[12.5px]"><span className="font-mono text-faint">{task.key}</span> <span className="text-st-failed">{task.error}</span></li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PlanTab({ tasks, run }: { tasks: Task[]; run: Run | null }) {
  const list = runTasks(tasks, run);
  if (list.length === 0) return <EmptyState title="No plan yet">The Project Manager step of a run creates the task plan.</EmptyState>;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-faint">
        Tasks of {run ? `run #${run.number}` : 'the project'} in plan order. The plan has no milestones or phases yet, so they are not grouped.
      </p>
      <ol className="space-y-1.5" aria-label="Plan">
        {list.map((task, index) => (
          <li key={task.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line-soft px-3 py-2">
            <span className="w-6 shrink-0 text-right text-[12px] text-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13px]" title={task.title}>{task.title}</span>
            <span className="font-mono text-[11px] text-faint">{task.key}</span>
            <span className="rounded border border-line px-1.5 text-[11px] text-muted">{task.role}</span>
            <StatusBadge status={task.status} />
            {task.dependsOn.length > 0 && <span className="w-full pl-8 text-[11px] text-faint">After: {task.dependsOn.join(', ')}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunsTab({ state }: { state: RunsState }) {
  const { runs, next, loaded, error, loadingMore, reload, loadMore } = state;
  if (error && runs.length === 0) return <ErrorState title="Could not load runs" message={error} onRetry={reload} />;
  if (!loaded) return <Loading label="Loading runs" />;
  if (runs.length === 0) return <EmptyState title="No runs yet">Use Start run to run a workflow on this project.</EmptyState>;
  return (
    <div className="space-y-2">
      {error && <p role="alert" className="text-[12px] text-st-failed">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12.5px]" aria-label="Runs">
          <thead className="text-[11px] uppercase tracking-wide text-faint">
            <tr>
              {['Run', 'Workflow', 'Status', 'Started', 'Duration', 'Cost', 'Tasks', 'Error', ''].map((heading) => <th key={heading} className="px-2 py-1.5 font-medium">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} data-run={run.id} className="border-t border-line-soft">
                <td className="px-2 py-1.5 font-medium">#{run.number}</td>
                <td className="max-w-[200px] truncate px-2 py-1.5" title={run.workflowName}>
                  {run.workflowName}{run.workflowVersion !== null && <span className="text-faint"> v{run.workflowVersion}</span>}
                </td>
                <td className="px-2 py-1.5"><RunStatusPill status={run.status} /></td>
                <td className="whitespace-nowrap px-2 py-1.5 text-muted" title={run.startedAt}>{timeAgo(run.startedAt)}</td>
                <td className="px-2 py-1.5 text-muted">{run.durationMs !== null ? formatMs(run.durationMs) : formatDuration(run.startedAt, run.finishedAt)}</td>
                <td className="px-2 py-1.5 text-muted">{formatCost(run.costUsd)}</td>
                <td className="px-2 py-1.5 text-muted">{run.tasksCompleted} / {run.tasksTotal}</td>
                <td className="max-w-[240px] truncate px-2 py-1.5 text-st-failed" title={run.errorSummary ?? undefined}>{run.errorSummary ?? ''}</td>
                <td className="px-2 py-1.5"><a href="#/builder" className="text-brand-2 hover:underline">Builder</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next !== null && (
        <div className="text-center"><Button size="sm" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button></div>
      )}
    </div>
  );
}

function TasksTab({ project, tasks }: { project: Project; tasks: Task[] }) {
  const headerProject = useStudio((state) => state.currentProjectId);
  return (
    <div className="space-y-3">
      {tasks.length > 0 ? <TaskBreakdown tasks={tasks} /> : <p className="text-[13px] text-muted">No tasks yet for the current run.</p>}
      <a href="#/tasks" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-ink-800 px-3 text-[13px] font-medium hover:bg-ink-700">
        <ExternalLink size={14} aria-hidden="true" />Open Tasks board
      </a>
      <p className="text-[12px] text-faint">
        The Tasks page shows the project selected in the header
        {headerProject !== project.id && <>; <span className="text-st-waiting">select “{project.name}” there to see its tasks</span></>}.
      </p>
    </div>
  );
}

function ReportTab({ projectId, refreshKey }: { projectId: string; refreshKey: string }) {
  const load = useCallback(() => getReport(projectId), [projectId]);
  const { data, error, loading, reload } = useLoad(load);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    reload();
  }, [refreshKey, reload]);
  if (error && data === null) return <ErrorState title="Could not load the report" message={error} onRetry={reload} />;
  if (loading && data === null) return <Loading label="Loading report" />;
  return <MarkdownTab text={data} emptyTitle="No delivery report yet" emptyText="The report appears when the run's final report step has produced it." />;
}

function SettingsTab({ project }: { project: Project }) {
  const rows: [string, ReactNode][] = [
    ['Test command', <code key="t" className="font-mono">{project.testCommand || '—'}</code>],
    ['Workspace mode', WORKSPACE_MODE_LABELS[project.workspaceMode]],
    ['Workspace path', <code key="w" className="break-all font-mono">{project.workspacePath}</code>],
    ['Integration branch', <code key="b" className="font-mono">{project.integrationBranch ?? 'Not created yet'}</code>],
    ['Base commit', <code key="c" className="font-mono">{project.baseCommit ?? '—'}</code>],
    ['Created', project.createdAt],
  ];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
        {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted">{label}</dt><dd className="min-w-0">{value}</dd></div>)}
      </dl>
      <p className="text-[12px] text-faint">Read-only. Settings are changed when the project is created.</p>
      <InstallScriptsSetting projectId={project.id} />
    </div>
  );
}

const ALLOW_SCRIPTS_WARNING = 'Allow package install scripts for this project?\n\n'
  + 'npm/pnpm/yarn install will then run every dependency\'s preinstall/install/postinstall script with your file access. '
  + 'Only allow this for projects whose dependencies you trust.';

/** P7-S8: package installs run with --ignore-scripts until the owner allows scripts for this project. */
function InstallScriptsSetting({ projectId }: { projectId: string }) {
  const load = useCallback(() => getInstallScripts(projectId), [projectId]);
  const { data, error, loading, reload } = useLoad(load);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const change = async (allowed: boolean) => {
    if (allowed && !window.confirm(ALLOW_SCRIPTS_WARNING)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setInstallScripts(projectId, allowed);
      reload();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  if (error && data === null) return <ErrorState title="Could not load the install-scripts setting" message={error} onRetry={reload} />;
  if (loading && data === null) return <Loading label="Loading install-scripts setting" />;
  return (
    <section aria-label="Package install scripts" className="rounded-md border border-line-soft p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-text">Package install scripts: {data ? 'allowed' : 'blocked'}</p>
          <p className="text-[12px] text-muted">
            {data ? 'npm/pnpm/yarn install runs dependency lifecycle scripts for this project.'
              : 'npm/pnpm/yarn install runs with --ignore-scripts, so no dependency script runs on your machine.'}
          </p>
        </div>
        <Button size="sm" variant={data ? 'secondary' : 'danger'} disabled={saving} onClick={() => void change(!data)}>
          {data ? 'Block scripts again' : 'Allow scripts'}
        </Button>
      </div>
      {saveError && <p role="alert" className="mt-2 text-[12px] text-st-failed">{saveError}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ tab bar and panel

export interface ProjectTabsProps {
  snapshot: ProjectSnapshot;
  run: Run | null;
  runs: RunsState;
  tab: ProjectTabId;
  onTabChange: (tab: ProjectTabId) => void;
}

function TabBody({ snapshot, run, runs, tab }: Omit<ProjectTabsProps, 'onTabChange'>) {
  const { project } = snapshot;
  switch (tab) {
    case 'overview': return <OverviewTab snapshot={snapshot} run={run} />;
    case 'requirements':
      return <MarkdownTab text={project.spec} emptyTitle="No specification yet" emptyText="This project has no saved specification." />;
    case 'architecture':
      return <MarkdownTab text={project.planMarkdown} emptyTitle="No architecture yet" emptyText="Generated by the Architect step." />;
    case 'plan': return <PlanTab tasks={snapshot.tasks} run={run} />;
    case 'runs': return <RunsTab state={runs} />;
    case 'tasks': return <TasksTab project={project} tasks={runTasks(snapshot.tasks, run)} />;
    case 'files': return <ProjectFiles key={project.id} snapshot={snapshot} />;
    case 'report': return <ReportTab projectId={project.id} refreshKey={project.updatedAt} />;
    case 'settings': return <SettingsTab project={project} />;
  }
}

export function ProjectTabs(props: ProjectTabsProps) {
  const { tab, onTabChange } = props;
  const move = (index: number, key: string): number | null => {
    const last = PROJECT_TABS.length - 1;
    if (key === 'ArrowRight') return index === last ? 0 : index + 1;
    if (key === 'ArrowLeft') return index === 0 ? last : index - 1;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    return null;
  };
  return (
    <Panel className="min-w-0 overflow-hidden">
      <div role="tablist" aria-label="Project details" className="flex gap-1 overflow-x-auto border-b border-line-soft px-4 pt-2">
        {PROJECT_TABS.map((item, index) => (
          <button key={item.id} type="button" id={`project-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
            aria-controls="project-tab-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => onTabChange(item.id)}
            onKeyDown={(event) => {
              const next = move(index, event.key);
              if (next === null) return;
              event.preventDefault();
              onTabChange(PROJECT_TABS[next].id);
              document.getElementById(`project-tab-${PROJECT_TABS[next].id}`)?.focus();
            }}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-[13px]', tab === item.id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text')}>
            {item.label}
          </button>
        ))}
      </div>
      <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${tab}`} tabIndex={0} className="min-w-0 overflow-x-auto p-4">
        <TabBody {...props} />
      </div>
    </Panel>
  );
}
