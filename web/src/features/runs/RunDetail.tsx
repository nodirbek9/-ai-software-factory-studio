import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunTimeline } from '@asf/shared';
import { Button, ErrorState, Panel, PanelHeader, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { failedNodes, formatCost, formatMs, RunStatusPill, TIMELINE_RENDER_LIMIT } from '@/features/workflows/RunPanel';
import { cancelRun, getRunTimeline } from '@/features/workflows/workflowsApi';
import { cn, statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { useRunEvents } from './useRunEvents';

export function RunDetail({ runId }: { runId: string }) {
  const projects = useStudio((state) => state.projects);
  const [timeline, setTimeline] = useState<RunTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const token = ++request.current;
    try {
      const result = await getRunTimeline(runId);
      if (request.current === token) { setTimeline(result); setError(null); }
    } catch (cause) {
      if (request.current === token) setError((cause as Error).message);
    }
  }, [runId]);
  const refresh = useCallback(() => { void reload(); }, [reload]);
  useEffect(() => { refresh(); return () => { request.current += 1; }; }, [refresh]);
  useRunEvents(refresh);

  const cancel = async () => {
    if (busy || !window.confirm(`Cancel run #${timeline?.run.number}? Running tasks will be stopped.`)) return;
    setBusy(true);
    try { await cancelRun(runId); await reload(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const openProjectView = async (view: 'builder' | 'tasks') => {
    if (!timeline || busy) return;
    setBusy(true);
    try {
      await useStudio.getState().selectProject(timeline.run.projectId);
      useStudio.getState().setView(view);
      if (view === 'builder' && timeline.run.workflowId) window.location.hash = `#/builder/${encodeURIComponent(timeline.run.workflowId)}`;
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  const run = timeline?.run;
  return <div className="space-y-4">
    <a href="#/runs" className="text-sm text-brand hover:underline">← Back to runs</a>
    {error && <ErrorState title="Could not load run" message={error} onRetry={refresh} />}
    {!timeline && !error && <div aria-label="Loading run" aria-busy="true"><Skeleton className="h-40 w-full" /></div>}
    {timeline && run && <>
      <Panel className="space-y-3 p-4">
        <h2 className="text-base font-semibold">Run #{run.number} · {projects.find((project) => project.id === run.projectId)?.name ?? run.projectId} · {run.workflowName}{run.workflowVersion !== null && ` v${run.workflowVersion}`}</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted"><RunStatusPill status={run.status} />
          <span>Started <time dateTime={run.startedAt} title={run.startedAt}>{timeAgo(run.startedAt)}</time></span>
          <span>Duration {formatMs(run.durationMs)}</span><span>Cost {formatCost(run.costUsd)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {['planning', 'awaiting_approval', 'running', 'paused'].includes(run.status) && <Button variant="danger" disabled={busy} onClick={() => void cancel()}>Cancel run</Button>}
          <Button disabled={busy || !run.workflowId} title={!run.workflowId ? 'This run has no saved workflow.' : undefined} onClick={() => void openProjectView('builder')}>Open in Workflow Builder</Button>
          {!run.workflowId && <span className="text-xs text-muted">This run has no saved workflow.</span>}
          <Button disabled={busy} onClick={() => void openProjectView('tasks')}>Open tasks</Button>
        </div>
      </Panel>
      <Panel><PanelHeader title="Failed steps" />
        {failedNodes(timeline).length === 0 ? <p className="p-4 text-sm text-muted">No failed steps.</p> : <ul className="divide-y divide-line-soft">
          {failedNodes(timeline).map((node) => <li key={node.nodeId} className="space-y-1 p-4 text-sm">
            <span className="font-medium">{timeline.graph.nodes.find((item) => item.id === node.nodeId)?.label ?? node.nodeId}</span>
            <p className="whitespace-pre-wrap break-words text-st-failed">{timeline.tasks.find((task) => node.taskKeys.includes(task.key) && task.error)?.error ?? node.error ?? 'Step failed.'}</p>
          </li>)}
        </ul>}
      </Panel>
      <NodeTimeline timeline={timeline} />
      <Panel><PanelHeader title="Events" />
        {timeline.entries.length > TIMELINE_RENDER_LIMIT && <p className="p-3 text-xs text-muted">Showing the newest {TIMELINE_RENDER_LIMIT} of {timeline.entries.length} events.</p>}
        {timeline.entries.length === 0 && <p className="p-4 text-sm text-muted">No events yet.</p>}
        <ol aria-label="Run events" className="max-h-96 overflow-auto font-mono text-xs">
          {timeline.entries.slice(-TIMELINE_RENDER_LIMIT).map((entry) => <li key={entry.id} className="flex items-start gap-3 border-t border-line-soft px-4 py-2">
            <time dateTime={entry.at} className="shrink-0 text-muted">{entry.at.slice(11, 19)}</time>
            <span className={cn('rounded border border-line px-1', entry.level === 'error' ? 'text-st-failed' : entry.level === 'warn' ? 'text-st-waiting' : 'text-muted')}>{entry.level}</span>
            <span className="text-faint">{entry.type}</span><span className="min-w-0 break-words">{entry.message}</span>
          </li>)}
        </ol>
      </Panel>
    </>}
  </div>;
}

function NodeTimeline({ timeline }: { timeline: RunTimeline }) {
  const start = Date.parse(timeline.run.startedAt);
  const end = Math.max(start + 1, Date.parse(timeline.run.finishedAt ?? new Date().toISOString()), ...timeline.nodes.map((node) => node.finishedAt ? Date.parse(node.finishedAt) : start));
  const span = end - start;
  return <Panel><PanelHeader title="Node timeline" />
    <ul aria-label="Node timeline" className="space-y-3 p-4">
      {timeline.nodes.map((node) => {
        const label = timeline.graph.nodes.find((item) => item.id === node.nodeId)?.label ?? node.nodeId;
        const left = node.startedAt ? Math.max(0, Math.min(100, (Date.parse(node.startedAt) - start) / span * 100)) : 0;
        const duration = node.durationMs ?? (node.startedAt ? (node.finishedAt ? Date.parse(node.finishedAt) : end) - Date.parse(node.startedAt) : 0);
        const width = Math.min(100 - left, Math.max(0.5, duration / span * 100));
        return <li key={node.nodeId} className={cn('grid grid-cols-[minmax(120px,1fr)_3fr] items-center gap-4 text-xs', node.status === 'not_started' && 'text-faint opacity-60')}>
          <div><span>{label}</span> <span>×{node.attempts}</span><div><StatusBadge status={node.status === 'not_started' ? 'pending' : node.status} /></div></div>
          <div className="relative h-6 rounded bg-ink-800">
            {node.startedAt && node.status !== 'not_started' ? <div role="img" aria-label={`${label}: ${node.status}, ${formatMs(duration)}, ×${node.attempts}`} className="absolute h-full rounded" style={{ left: `${left}%`, width: `${width}%`, background: statusMeta(node.status).color }} /> : <span className="px-2">Not started</span>}
          </div>
        </li>;
      })}
    </ul>
  </Panel>;
}
