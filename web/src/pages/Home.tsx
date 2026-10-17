import type { OverviewResponse, SystemHealth, UsageSummary } from '@asf/shared';
import { FolderPlus } from 'lucide-react';
import { useStudio } from '@/store/studio';
import { Button, EmptyState, ErrorState, Panel, Skeleton } from '@/components/ui/primitives';
import { useV2, type V2Result } from '@/features/home/useV2';
import { Greeting } from '@/features/home/Greeting';
import { KpiRow } from '@/features/home/KpiRow';
import { ProjectWorkflow } from '@/features/home/ProjectWorkflow';
import { AgentHealth } from '@/features/home/AgentHealth';
import { ActiveProjects } from '@/features/home/ActiveProjects';
import { RecentRuns } from '@/features/home/RecentRuns';
import { ModelUsage } from '@/features/home/ModelUsage';
import { ProjectProgress } from '@/features/home/ProjectProgress';
import { QuickLaunch } from '@/features/home/QuickLaunch';

function HomeSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading overview">
      <div className="grid grid-cols-2 gap-3 min-[1366px]:grid-cols-3 min-[1600px]:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-[108px]" />)}
      </div>
      <div className="grid gap-4 min-[1600px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <div className="grid gap-4 min-[1366px]:grid-cols-2 min-[1600px]:grid-cols-3">
        <Skeleton className="h-64" /><Skeleton className="h-64" /><Skeleton className="h-64" />
      </div>
    </div>
  );
}

function HomeGrid({ overview, usage24, usage7, health }: {
  overview: OverviewResponse;
  usage24: V2Result<UsageSummary>;
  usage7: V2Result<UsageSummary>;
  health: V2Result<SystemHealth>;
}) {
  return (
    <div className="space-y-4">
      <KpiRow overview={overview} usage={usage24} health={health} />
      <div className="grid items-start gap-4 min-[1600px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ProjectWorkflow current={overview.currentProject} />
        <AgentHealth agents={overview.agentHealth} />
      </div>
      <div className="grid items-start gap-4 min-[1366px]:grid-cols-2 min-[1600px]:grid-cols-3">
        <ActiveProjects projects={overview.activeProjects} />
        <RecentRuns runs={overview.recentRuns} />
        <div className="min-w-0 min-[1366px]:col-span-2 min-[1600px]:col-span-1">
          <ModelUsage usage24={usage24} usage7={usage7} />
        </div>
      </div>
      <div className="grid items-start gap-4 min-[1366px]:grid-cols-2">
        <ProjectProgress current={overview.currentProject} />
        <QuickLaunch />
      </div>
    </div>
  );
}

export function Home() {
  const currentProjectId = useStudio((s) => s.currentProjectId);
  const setView = useStudio((s) => s.setView);
  const overview = useV2<OverviewResponse>(`/api/v2/overview${currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : ''}`);
  const usage24 = useV2<UsageSummary>('/api/v2/usage/summary?range=24h');
  const usage7 = useV2<UsageSummary>('/api/v2/usage/summary?range=7d');
  const health = useV2<SystemHealth>('/api/v2/system/health');
  const data = overview.data;

  return (
    <div className="h-full overflow-y-auto p-4 2xl:p-6">
      <div className="mx-auto flex max-w-[1680px] flex-col gap-4">
        <Greeting />
        {overview.error && data && (
          <p role="status" className="flex items-center justify-between gap-3 rounded-lg border border-st-waiting/30 bg-st-waiting/10 px-3 py-1.5 text-[12.5px] text-st-waiting">
            <span>Could not refresh the overview ({overview.error}). Showing the last data.</span>
            <button type="button" onClick={overview.reload} className="underline">Retry</button>
          </p>
        )}
        {data ? (
          data.projects.total === 0 ? (
            <Panel>
              <EmptyState icon={<FolderPlus size={28} />} title="Start with your first project">
                <p>Create a project from a specification, import a repository or try the bundled sample. Everything on this page fills in as agents work.</p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button variant="primary" onClick={() => setView('projects')}>New project</Button>
                  <Button onClick={() => setView('projects')}>Try the sample</Button>
                </div>
              </EmptyState>
            </Panel>
          ) : (
            <HomeGrid overview={data} usage24={usage24} usage7={usage7} health={health} />
          )
        ) : overview.error ? (
          <Panel><ErrorState title="Could not load the overview" message={overview.error} onRetry={overview.reload} /></Panel>
        ) : (
          <HomeSkeleton />
        )}
      </div>
    </div>
  );
}
