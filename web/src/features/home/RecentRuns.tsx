import type { LiveFinished } from '@asf/shared';
import { CheckCircle2, XCircle } from 'lucide-react';
import { cn, statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { EmptyState, Panel, PanelHeader } from '@/components/ui/primitives';
import { formatMs } from './format';

function RunRow({ run }: { run: LiveFinished }) {
  const done = run.status === 'completed';
  const meta = statusMeta(run.status);
  const Icon = done ? CheckCircle2 : XCircle;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Icon size={17} className={cn('shrink-0', done ? 'text-st-completed' : meta.text)} aria-label={done ? 'Done' : meta.label} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]" title={run.error ?? run.taskTitle}>{run.taskTitle}</p>
        <p className="truncate text-[11.5px] text-muted">{run.projectName} · {timeAgo(run.finishedAt)}</p>
      </div>
      <span className="shrink-0 text-[11.5px] tabular-nums text-muted">{formatMs(run.durationMs)}</span>
    </li>
  );
}

export function RecentRuns({ runs }: { runs: LiveFinished[] }) {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Recent Runs">
        <button type="button" onClick={() => setView('monitor')} className="rounded text-[12px] text-brand hover:underline">View all →</button>
      </PanelHeader>
      {runs.length ? (
        <ul className="divide-y divide-line-soft">{runs.map((run) => <RunRow key={run.taskId} run={run} />)}</ul>
      ) : (
        <EmptyState title="No finished tasks yet">Tasks appear here as soon as an agent finishes one.</EmptyState>
      )}
    </Panel>
  );
}
