import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project, ProjectStatus, Run, WorkflowSummary } from '@asf/shared';
import { ChevronDown, ChevronLeft, Pause, Play, Square } from 'lucide-react';
import { Button, ErrorState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { CopyButton } from '@/features/projects/RepoView';
import {
  ProjectTabs, currentRunOf, errorMessage, useLoad, useProjectEvents, useRuns, type Loaded, type ProjectTabId, type RunsState,
} from '@/features/projects/ProjectTabs';
import { cancelProject, getSnapshot, listRuns, listWorkflows, pauseProject, resumeProject, startRun } from '@/features/projects/projectsApi';
import { activeRunOf } from '@/features/workflows/workflowsStore';

const WORKSPACE_MODE_LABELS: Record<Project['workspaceMode'], string> = { new: 'New workspace', sample: 'Sample', import: 'Imported' };
const CANCEL_CONFIRM = 'Stop this project? Running tasks are cancelled; completed work stays on the integration branch.';

type Busy = 'start' | 'pause' | 'resume' | 'cancel' | null;

/** Disabled buttons swallow pointer events, so the reason is also a tooltip on a wrapper. */
function Gated({ reason, children }: { reason: string | null; children: ReactNode }) {
  return <span title={reason ?? undefined} className="inline-flex">{children}</span>;
}

// V1 rules: pause/stop apply while the project is working, resume only while paused.
const isLive = (status: ProjectStatus): boolean => status === 'planning' || status === 'running' || status === 'awaiting_approval';

function controlReasons(status: ProjectStatus, busy: Busy) {
  const wait = busy ? 'Another action is in progress.' : null;
  return {
    pause: wait ?? (isLive(status) ? null : 'Only a planning or running project can be paused.'),
    resume: wait ?? (status === 'paused' ? null : 'The project is not paused.'),
    cancel: wait ?? (isLive(status) || status === 'paused' ? null : 'The project is not running.'),
  };
}

function startReason(workflows: Loaded<WorkflowSummary[]>, runs: RunsState, busy: Busy): string | null {
  const active = activeRunOf(runs.runs);
  if (active) return `Run #${active.number} is still ${active.status.replace('_', ' ')}. Wait for it to finish or cancel it.`;
  if (!runs.loaded) return 'Checking for an active run…';
  if (runs.error && runs.runs.length === 0) return `Could not check for an active run: ${runs.error}`;
  if (workflows.loading && !workflows.data) return 'Loading workflows…';
  if (workflows.error && !workflows.data) return `Could not load workflows: ${workflows.error}`;
  if (!workflows.data?.some((workflow) => !workflow.archived)) return 'No workflows available. Create one in the Builder.';
  return busy ? 'Another action is in progress.' : null;
}

function WorkflowItems({ title, items, onPick }: { title: string; items: WorkflowSummary[]; onPick: (workflow: WorkflowSummary) => void }) {
  if (items.length === 0) return null;
  return (
    <div role="group" aria-label={title}>
      <div className="px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">{title}</div>
      {items.map((workflow) => (
        <button key={workflow.id} type="button" role="menuitem" onClick={() => onPick(workflow)}
          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text hover:bg-ink-800">
          {workflow.name}<span className="text-faint"> · v{workflow.version} · {workflow.nodeCount} nodes</span>
        </button>
      ))}
    </div>
  );
}

function StartRunMenu({ workflows, reason, projectId, onStart }: {
  workflows: WorkflowSummary[]; reason: string | null; projectId: string; onStart: (workflow: WorkflowSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (reason) setOpen(false); }, [reason]);

  const live = workflows.filter((workflow) => !workflow.archived);
  const pick = (workflow: WorkflowSummary) => { setOpen(false); onStart(workflow); };
  return (
    <div ref={root} className="relative">
      <Gated reason={reason}>
        <Button variant="primary" disabled={!!reason} title={reason ?? undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          Start run<ChevronDown size={14} aria-hidden="true" />
        </Button>
      </Gated>
      {open && (
        <div role="menu" aria-label="Start run" className="absolute right-0 z-30 mt-1 max-h-80 min-w-[260px] overflow-y-auto rounded-lg border border-line bg-ink-900 p-1 shadow-2xl shadow-black/40">
          <WorkflowItems title="Project workflows" items={live.filter((workflow) => workflow.projectId === projectId)} onPick={pick} />
          <WorkflowItems title="Global templates" items={live.filter((workflow) => workflow.projectId === null)} onPick={pick} />
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  project: Project;
  workflows: Loaded<WorkflowSummary[]>;
  runs: RunsState;
  busy: Busy;
  onStart: (workflow: WorkflowSummary) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

function Header({ project, workflows, runs, busy, onStart, onPause, onResume, onCancel }: HeaderProps) {
  const reasons = controlReasons(project.status, busy);
  return (
    <header className="space-y-2">
      <a href="#/projects" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text"><ChevronLeft size={13} aria-hidden="true" />Projects</a>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-lg font-semibold">{project.name}</h1>
            <StatusBadge status={project.status} />
            <span className="text-[12px] text-muted">{WORKSPACE_MODE_LABELS[project.workspaceMode]}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1 text-[12px] text-muted">
            <span className="min-w-0 truncate font-mono" title={project.workspacePath}>{project.workspacePath}</span>
            <CopyButton text={project.workspacePath} label="workspace path" />
          </div>
          <div className="text-[12px] text-faint">
            Integration branch: <span className="font-mono">{project.integrationBranch ?? 'Not created yet'}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StartRunMenu workflows={workflows.data ?? []} reason={startReason(workflows, runs, busy)} projectId={project.id} onStart={onStart} />
          <Gated reason={reasons.pause}><Button disabled={!!reasons.pause} title={reasons.pause ?? undefined} onClick={onPause}><Pause size={14} aria-hidden="true" />Pause</Button></Gated>
          <Gated reason={reasons.resume}><Button disabled={!!reasons.resume} title={reasons.resume ?? undefined} onClick={onResume}><Play size={14} aria-hidden="true" />Resume</Button></Gated>
          <Gated reason={reasons.cancel}><Button variant="danger" disabled={!!reasons.cancel} title={reasons.cancel ?? undefined} onClick={onCancel}><Square size={13} aria-hidden="true" />Cancel</Button></Gated>
        </div>
      </div>
    </header>
  );
}

function DetailSkeleton() {
  return <div className="space-y-3" aria-busy="true" aria-label="Loading project"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-64 w-full" /></div>;
}

/** `#/projects/:id` — header with run controls and the Overview / Requirements / … tabs. */
export default function ProjectDetail({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<ProjectTabId>('overview');
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSnapshot = useCallback(() => getSnapshot(projectId), [projectId]);
  const loadWorkflows = useCallback(() => listWorkflows(projectId), [projectId]);
  const snapshot = useLoad(loadSnapshot);
  const workflows = useLoad(loadWorkflows);
  const runs = useRuns(projectId, listRuns);
  const { reload: reloadSnapshot } = snapshot;
  const { reload: reloadRuns } = runs;

  useEffect(() => { setTab('overview'); setActionError(null); }, [projectId]);
  useProjectEvents(projectId, useCallback(() => { reloadSnapshot(); reloadRuns(); }, [reloadSnapshot, reloadRuns]));

  const perform = async (kind: Exclude<Busy, null>, work: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await work();
      reloadSnapshot();
      reloadRuns();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const start = (workflow: WorkflowSummary) => void perform('start', () => startRun(projectId, workflow.id));
  const cancel = () => { if (window.confirm(CANCEL_CONFIRM)) void perform('cancel', () => cancelProject(projectId)); };

  let body: ReactNode;
  if (snapshot.error && !snapshot.data) body = <ErrorState title="Could not load the project" message={snapshot.error} onRetry={reloadSnapshot} />;
  else if (!snapshot.data) body = <DetailSkeleton />;
  else {
    const run: Run | null = currentRunOf(runs.runs);
    body = (
      <>
        <Header project={snapshot.data.project} workflows={workflows} runs={runs} busy={busy} onStart={start}
          onPause={() => void perform('pause', () => pauseProject(projectId))}
          onResume={() => void perform('resume', () => resumeProject(projectId))} onCancel={cancel} />
        {actionError && <p role="alert" className="text-[13px] text-st-failed">{actionError}</p>}
        {snapshot.error && <p role="alert" className="text-[12px] text-st-failed">Could not refresh: {snapshot.error}</p>}
        <ProjectTabs snapshot={snapshot.data} run={run} runs={runs} tab={tab} onTabChange={setTab} />
      </>
    );
  }
  return <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">{body}</div>;
}
