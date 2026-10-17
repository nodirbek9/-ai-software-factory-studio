import type { OverviewResponse } from '@asf/shared';
import { cn, statusMeta } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { Button, EmptyState, Panel, PanelHeader, Progress } from '@/components/ui/primitives';

function Count({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line-soft bg-raised/50 px-3 py-2">
      <div className={cn('text-[20px] font-semibold leading-tight tabular-nums', tone)}>{value}</div>
      <div className="truncate text-[11.5px] text-muted">{label}</div>
    </div>
  );
}

export function ProjectProgress({ current }: { current: OverviewResponse['currentProject'] }) {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Project Progress">
        {current && <span className="max-w-[200px] truncate text-[12px] text-muted">{current.name}</span>}
      </PanelHeader>
      {current ? (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            <Progress value={current.progress.total ? current.progress.completed / current.progress.total : 0} color={statusMeta(current.status).color} />
            <span className="shrink-0 text-[12px] tabular-nums text-muted">
              {current.progress.total ? Math.round((current.progress.completed / current.progress.total) * 100) : 0}% verified
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Count label="Total" value={current.progress.total} />
            <Count label="Completed" value={current.progress.completed} tone="text-st-completed" />
            <Count label="Running" value={current.progress.running} tone="text-st-running" />
            <Count label="Blocked" value={current.progress.blocked} tone="text-st-blocked" />
            <Count label="Failed" value={current.progress.failed} tone="text-st-failed" />
          </div>
        </div>
      ) : (
        <EmptyState title="No project selected">
          <p>Task counts appear here once a project is selected.</p>
          <Button variant="primary" className="mt-3" onClick={() => setView('projects')}>Open Projects</Button>
        </EmptyState>
      )}
    </Panel>
  );
}
