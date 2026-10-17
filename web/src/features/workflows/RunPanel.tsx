import { useMemo, type ReactNode } from 'react';
import { Ban, ChevronDown, ChevronUp } from 'lucide-react';
import type { Run, RunNodeStatus, RunStatus, RunTimeline, RunTimelineEntry, WorkflowGraph, WorkflowIssue } from '@asf/shared';
import { Button, ErrorState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { cn, formatDuration, statusMeta } from '@/lib/utils';
import { activeRunOf, useWorkflows } from './workflowsStore';

export const RUN_PANEL_TABS = ['history', 'validation', 'simulation', 'timeline', 'failed'] as const;
export type RunPanelTab = (typeof RUN_PANEL_TABS)[number];

/** The timeline renders without a virtual list, so only the newest entries are mounted. */
export const TIMELINE_RENDER_LIMIT = 500;

const RUN_STATUS_LABELS: Record<RunStatus, { label: string; tone: string }> = {
  planning: { label: 'Planning', tone: 'planning' },
  awaiting_approval: { label: 'Needs approval', tone: 'awaiting_approval' },
  running: { label: 'Running', tone: 'running' },
  paused: { label: 'Paused', tone: 'paused' },
  completed: { label: 'Completed', tone: 'completed' },
  completed_with_failures: { label: 'Completed with failures', tone: 'blocked' },
  failed: { label: 'Failed', tone: 'failed' },
  cancelled: { label: 'Cancelled', tone: 'cancelled' },
};

export function RunStatusPill({ status }: { status: RunStatus }) {
  const { label, tone } = RUN_STATUS_LABELS[status] ?? { label: status, tone: 'idle' };
  const meta = statusMeta(tone);
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', meta.text)}
      style={{ borderColor: `color-mix(in srgb, ${meta.color} 35%, transparent)`, background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}>
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.bg, meta.live && 'animate-rail')} aria-hidden="true" />
      {label}
    </span>
  );
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/** Measured cost only; a provider that reports none shows "not reported", never an estimate. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'not reported';
  return `$${costUsd.toFixed(costUsd > 0 && costUsd < 0.01 ? 4 : 2)}`;
}

function nodeTitle(graph: WorkflowGraph | undefined, nodeId: string): string {
  return graph?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

const timeOf = (iso: string): string => (iso.length >= 19 ? iso.slice(11, 19) : iso);

const LEVEL_TONE: Record<RunTimelineEntry['level'], string> = {
  debug: 'text-faint', info: 'text-muted', warn: 'text-st-waiting', error: 'text-st-failed',
};

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-[12.5px] text-muted">{children}</p>;
}

// ------------------------------------------------------------------ tabs

function RunHistory() {
  const runs = useWorkflows((s) => s.runs);
  const loaded = useWorkflows((s) => s.runsLoaded);
  const error = useWorkflows((s) => s.runsError);
  const next = useWorkflows((s) => s.runsNext);
  const loadingMore = useWorkflows((s) => s.loadingMoreRuns);
  const selectedRunId = useWorkflows((s) => s.selectedRunId);
  const store = useWorkflows.getState;
  if (error && runs.length === 0) return <ErrorState title="Could not load runs" message={error} onRetry={() => void store().refreshRuns()} />;
  if (!loaded) return <div className="space-y-2 p-3" aria-busy="true"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /></div>;
  if (runs.length === 0) return <Hint>No runs yet. Save and validate a workflow, then press Run.</Hint>;
  return (
    <div>
      <table className="w-full text-left text-[12.5px]">
        <thead className="sticky top-0 bg-surface text-[11px] uppercase tracking-wide text-faint">
          <tr>
            <th className="px-3 py-1.5 font-medium">Run</th><th className="px-2 py-1.5 font-medium">Workflow</th>
            <th className="px-2 py-1.5 font-medium">Status</th><th className="px-2 py-1.5 font-medium">Trigger</th>
            <th className="px-2 py-1.5 font-medium">Duration</th><th className="px-2 py-1.5 font-medium">Cost</th>
            <th className="px-2 py-1.5 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => <RunRow key={run.id} run={run} selected={run.id === selectedRunId} />)}
        </tbody>
      </table>
      {next !== null && (
        <div className="p-2 text-center">
          <Button size="sm" disabled={loadingMore} onClick={() => void store().loadMoreRuns()}>{loadingMore ? 'Loading…' : 'Load more'}</Button>
        </div>
      )}
    </div>
  );
}

function RunRow({ run, selected }: { run: Run; selected: boolean }) {
  const select = () => { void useWorkflows.getState().selectRun(run.id); };
  return (
    <tr data-run={run.id} aria-current={selected ? 'true' : undefined} tabIndex={0} onClick={select}
      onKeyDown={(event) => { if (event.key === 'Enter') select(); }}
      className={cn('cursor-pointer border-t border-line-soft hover:bg-ink-800/60', selected && 'bg-brand/10')}>
      <td className="px-3 py-1.5 font-medium">#{run.number}</td>
      <td className="max-w-[200px] truncate px-2 py-1.5" title={run.workflowName}>
        {run.workflowName}{run.workflowVersion !== null && <span className="text-faint"> v{run.workflowVersion}</span>}
      </td>
      <td className="px-2 py-1.5"><RunStatusPill status={run.status} /></td>
      <td className="px-2 py-1.5 text-muted">{run.trigger}</td>
      <td className="px-2 py-1.5 text-muted">{run.durationMs !== null ? formatMs(run.durationMs) : formatDuration(run.startedAt, run.finishedAt)}</td>
      <td className="px-2 py-1.5 text-muted">{formatCost(run.costUsd)}</td>
      <td className="max-w-[260px] truncate px-2 py-1.5 text-st-failed" title={run.errorSummary ?? undefined}>{run.errorSummary ?? ''}</td>
    </tr>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: WorkflowIssue[]; tone: string }) {
  if (issues.length === 0) return null;
  const focus = (nodeId: string) => useWorkflows.getState().focusNode(nodeId);
  return (
    <section aria-label={title} className="px-3 py-2">
      <h3 className={cn('mb-1 text-[11px] font-semibold uppercase tracking-wide', tone)}>{title} ({issues.length})</h3>
      <ul className="space-y-1">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? ''}-${index}`}>
            <button type="button" disabled={!issue.nodeId} onClick={() => issue.nodeId && focus(issue.nodeId)}
              title={issue.nodeId ? `Select node ${issue.nodeId}` : undefined}
              className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[12.5px] enabled:hover:bg-ink-800 disabled:cursor-default">
              <code className={cn('shrink-0 text-[11px]', tone)}>{issue.code}</code>
              <span className="min-w-0 flex-1">{issue.message}</span>
              {issue.nodeId && <span className="shrink-0 text-[11px] text-faint">{issue.nodeId}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ValidationTab() {
  const validation = useWorkflows((s) => s.validation);
  const validating = useWorkflows((s) => s.validating);
  if (validating && !validation) return <Hint>Validating…</Hint>;
  if (!validation) return <Hint>Not validated yet. Press Validate in the toolbar.</Hint>;
  return (
    <div>
      {validation.ok && <p role="status" className="px-4 pt-3 text-[12.5px] text-st-completed">The workflow is valid.</p>}
      <IssueList title="Errors" issues={validation.errors} tone="text-st-failed" />
      <IssueList title="Warnings" issues={validation.warnings} tone="text-st-waiting" />
      {validation.ok && validation.warnings.length === 0 && <Hint>No warnings.</Hint>}
    </div>
  );
}

function SimulationTab() {
  const simulation = useWorkflows((s) => s.simulation);
  const simulating = useWorkflows((s) => s.simulating);
  if (simulating) return <Hint>Compiling…</Hint>;
  if (!simulation) return <Hint>Press Simulate to see the tasks this workflow would create. Nothing is started.</Hint>;
  return (
    <div>
      {simulation.tasks.length === 0 ? (
        <Hint>No tasks: the workflow has validation errors (see Validation).</Hint>
      ) : (
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 bg-surface text-[11px] uppercase tracking-wide text-faint">
            <tr>
              <th className="px-3 py-1.5 font-medium">#</th><th className="px-2 py-1.5 font-medium">Task</th>
              <th className="px-2 py-1.5 font-medium">Role</th><th className="px-2 py-1.5 font-medium">Kind</th>
              <th className="px-2 py-1.5 font-medium">Depends on</th><th className="px-2 py-1.5 font-medium">Node</th>
            </tr>
          </thead>
          <tbody>
            {simulation.tasks.map((task, index) => (
              <tr key={task.key} className="border-t border-line-soft">
                <td className="px-3 py-1.5 text-faint">{index + 1}</td>
                <td className="px-2 py-1.5"><span className="font-medium">{task.title}</span> <code className="text-[11px] text-faint">{task.key}</code></td>
                <td className="px-2 py-1.5 text-muted">{task.role}</td>
                <td className="px-2 py-1.5 text-muted">{task.kind}</td>
                <td className="px-2 py-1.5 text-muted">{task.dependsOn.length ? task.dependsOn.join(', ') : '—'}</td>
                <td className="px-2 py-1.5 text-faint">{task.nodeId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {simulation.notes.length > 0 && (
        <ul className="space-y-0.5 border-t border-line-soft px-4 py-2 text-[12px] text-muted">
          {simulation.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

function TimelineTab() {
  const runId = useWorkflows((s) => s.selectedRunId);
  const timeline = useWorkflows((s) => s.timeline);
  const error = useWorkflows((s) => s.timelineError);
  if (!runId) return <Hint>Select a run in Run History to see its timeline.</Hint>;
  if (error && !timeline) return <ErrorState title="Could not load the timeline" message={error} onRetry={() => void useWorkflows.getState().refreshTimeline()} />;
  if (!timeline) return <div className="space-y-2 p-3" aria-busy="true"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-3/4" /></div>;
  const hidden = Math.max(0, timeline.entries.length - TIMELINE_RENDER_LIMIT);
  const entries = hidden ? timeline.entries.slice(hidden) : timeline.entries;
  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
        <span className="font-medium">Run #{timeline.run.number}</span><RunStatusPill status={timeline.run.status} />
        <span className="text-muted">{timeline.run.tasksCompleted} / {timeline.run.tasksTotal} tasks</span>
      </div>
      {entries.length === 0 && <Hint>No events yet.</Hint>}
      {hidden > 0 && <p className="px-4 pb-1 text-[11px] text-faint">Showing the newest {TIMELINE_RENDER_LIMIT} of {timeline.entries.length} events.</p>}
      <ol className="font-mono text-[12px]" aria-label="Run events">
        {entries.map((entry) => (
          <li key={entry.id} className="flex gap-3 border-t border-line-soft px-4 py-1">
            <time className="shrink-0 text-faint" dateTime={entry.at}>{timeOf(entry.at)}</time>
            <span className="w-28 shrink-0 truncate text-faint" title={entry.type}>{entry.type}</span>
            <span className={cn('min-w-0 flex-1 break-words', LEVEL_TONE[entry.level])}>{entry.message}</span>
            {entry.nodeId && <span className="shrink-0 text-faint">{nodeTitle(timeline.graph, entry.nodeId)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function failedNodes(timeline: RunTimeline | null): RunNodeStatus[] {
  return timeline ? timeline.nodes.filter((node) => node.error || node.status === 'failed') : [];
}

function FailedTab() {
  const runId = useWorkflows((s) => s.selectedRunId);
  const timeline = useWorkflows((s) => s.timeline);
  const failed = useMemo(() => failedNodes(timeline), [timeline]);
  if (!runId || !timeline) return <Hint>Select a run in Run History to see its failed steps.</Hint>;
  if (failed.length === 0) return <Hint>No failed steps in run #{timeline.run.number}.</Hint>;
  return (
    <ul className="divide-y divide-line-soft">
      {failed.map((node) => (
        <li key={node.nodeId}>
          <button type="button" onClick={() => useWorkflows.getState().focusNode(node.nodeId)}
            className="block w-full px-4 py-2 text-left hover:bg-ink-800/60">
            <span className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium">{nodeTitle(timeline.graph, node.nodeId)}</span>
              <StatusBadge status={node.status === 'not_started' ? 'pending' : node.status} />
              <span className="text-faint">{node.attempts} {node.attempts === 1 ? 'attempt' : 'attempts'}</span>
            </span>
            {node.error && <span className="mt-1 block whitespace-pre-wrap break-words font-mono text-[12px] text-st-failed">{node.error}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ panel

const TAB_PANELS: Record<RunPanelTab, () => ReactNode> = {
  history: () => <RunHistory />,
  validation: () => <ValidationTab />,
  simulation: () => <SimulationTab />,
  timeline: () => <TimelineTab />,
  failed: () => <FailedTab />,
};

export interface RunPanelProps {
  tab: RunPanelTab;
  onTabChange: (tab: RunPanelTab) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RunPanel({ tab, onTabChange, open, onOpenChange }: RunPanelProps) {
  const runs = useWorkflows((s) => s.runs);
  const validation = useWorkflows((s) => s.validation);
  const timeline = useWorkflows((s) => s.timeline);
  const active = activeRunOf(runs);
  const failedCount = failedNodes(timeline).length;
  const issueCount = validation ? validation.errors.length + validation.warnings.length : 0;
  const labels: Record<RunPanelTab, string> = {
    history: 'Run History',
    validation: issueCount > 0 ? `Validation (${issueCount})` : 'Validation',
    simulation: 'Simulation',
    timeline: 'Timeline',
    failed: failedCount > 0 ? `Failed steps (${failedCount})` : 'Failed steps',
  };

  const cancel = () => {
    if (!active) return;
    if (window.confirm(`Cancel run #${active.number}? Running tasks are stopped and pending ones are cancelled; completed work stays.`)) {
      void useWorkflows.getState().cancelRun(active.id);
    }
  };

  return (
    <section aria-label="Run panel" className="flex min-h-0 shrink-0 flex-col border-t border-line-soft bg-surface">
      <div className="flex items-center gap-1 px-2">
        <div role="tablist" aria-label="Run panel tabs" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {RUN_PANEL_TABS.map((id) => (
            <button key={id} type="button" role="tab" id={`run-tab-${id}`} aria-selected={open && tab === id} aria-controls="run-tabpanel"
              onClick={() => { onTabChange(id); onOpenChange(true); }}
              className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-[12.5px] transition-colors',
                open && tab === id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text')}>
              {labels[id]}
            </button>
          ))}
        </div>
        {active && (
          <Button size="sm" variant="danger" onClick={cancel} title={`Cancel run #${active.number}`}>
            <Ban size={13} aria-hidden="true" /> Cancel run
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={() => onOpenChange(!open)} aria-expanded={open}
          aria-label={open ? 'Collapse run panel' : 'Expand run panel'}>
          {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
        </Button>
      </div>
      {open && (
        <div id="run-tabpanel" role="tabpanel" aria-labelledby={`run-tab-${tab}`} className="h-56 overflow-auto border-t border-line-soft">
          {TAB_PANELS[tab]()}
        </div>
      )}
    </section>
  );
}
