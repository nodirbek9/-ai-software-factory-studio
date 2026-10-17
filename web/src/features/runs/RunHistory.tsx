import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunStatus, RunsListPage } from '@asf/shared';
import { Button, EmptyState, ErrorState, Field, Panel, Select, Skeleton } from '@/components/ui/primitives';
import { RunStatusPill, formatCost, formatMs } from '@/features/workflows/RunPanel';
import { listAllRuns } from '@/features/workflows/workflowsApi';
import { timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { useRunEvents } from './useRunEvents';

const STATUSES: RunStatus[] = ['planning', 'awaiting_approval', 'running', 'paused', 'completed', 'completed_with_failures', 'failed', 'cancelled'];

export function RunHistory() {
  const projects = useStudio((state) => state.projects);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<RunStatus | ''>('');
  // A separate instance keeps requests from an old filter from replacing the new results.
  return <div className="space-y-4">
    <div className="flex gap-3">
      <Field label="Project"><Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">All</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select></Field>
      <Field label="Status"><Select value={status} onChange={(event) => setStatus(event.target.value as RunStatus | '')}>
        <option value="">All</option>{STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
      </Select></Field>
    </div>
    <HistoryResults key={`${projectId}:${status}`} projectId={projectId} status={status} />
  </div>;
}

function HistoryResults({ projectId, status }: { projectId: string; status: RunStatus | '' }) {
  const projects = useStudio((state) => state.projects);
  const [page, setPage] = useState<RunsListPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(async (before?: string) => {
    const token = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const result = await listAllRuns({ projectId: projectId || undefined, status: status || undefined, before });
      if (token !== request.current) return;
      setPage((previous) => {
        if (!before || !previous) return result;
        const known = new Set(previous.runs.map((run) => run.id));
        return { ...result, runs: [...previous.runs, ...result.runs.filter((run) => !known.has(run.id))] };
      });
    } catch (cause) {
      if (token === request.current) setError((cause as Error).message);
    } finally {
      if (token === request.current) setBusy(false);
    }
  }, [projectId, status]);
  const refresh = useCallback(() => { void load(); }, [load]);
  useEffect(() => { refresh(); return () => { request.current += 1; }; }, [refresh]);
  useRunEvents(refresh);

  return <Panel className="overflow-hidden">
    {error && <ErrorState title="Could not load runs" message={error} onRetry={() => void load(page?.nextBefore ?? undefined)} />}
    {!page && !error && <div aria-label="Loading runs" aria-busy="true" className="space-y-3 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-32 w-full" /></div>}
    {page?.runs.length === 0 && <EmptyState title="No runs yet"><Button onClick={() => useStudio.getState().setView('builder')}>Open Workflow Builder</Button></EmptyState>}
    {page && page.runs.length > 0 && <div className="overflow-x-auto">
      <table aria-label="Run history" className="w-full text-left text-[12.5px] [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-2">
        <thead className="text-xs text-muted"><tr>{['Run', 'Project', 'Workflow', 'Status', 'Trigger', 'Started', 'Duration', 'Cost', 'Tasks', 'Error'].map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{page.runs.map((run) => <tr key={run.id} className="border-t border-line-soft hover:bg-ink-800/60">
          <td><a className="text-brand hover:underline" href={`#/runs/${encodeURIComponent(run.id)}`}>#{run.number}</a></td>
          <td>{projects.find((project) => project.id === run.projectId)?.name ?? run.projectId}</td>
          <td>{run.workflowName}{run.workflowVersion !== null && ` v${run.workflowVersion}`}</td>
          <td><RunStatusPill status={run.status} /></td><td>{run.trigger}</td>
          <td><time dateTime={run.startedAt} title={run.startedAt}>{timeAgo(run.startedAt)}</time></td>
          <td>{formatMs(run.durationMs)}</td><td>{formatCost(run.costUsd)}</td><td>{run.tasksCompleted}/{run.tasksTotal}</td>
          <td className="max-w-60 truncate text-st-failed" title={run.errorSummary ?? undefined}>{run.errorSummary ?? '—'}</td>
        </tr>)}</tbody>
      </table>
      {page.nextBefore !== null && <div className="p-3 text-center"><Button disabled={busy} onClick={() => void load(page.nextBefore ?? undefined)}>{busy ? 'Loading…' : 'Load more'}</Button></div>}
    </div>}
  </Panel>;
}
