import type { OverviewProject } from '@asf/shared';
import { statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { EmptyState, Panel, PanelHeader, Progress, StatusBadge } from '@/components/ui/primitives';

function ProjectRow({ project }: { project: OverviewProject }) {
  const selectProject = useStudio((s) => s.selectProject);
  const setView = useStudio((s) => s.setView);
  const ratio = project.tasksTotal ? project.tasksCompleted / project.tasksTotal : 0;
  return (
    <li>
      <button type="button" onClick={() => { void selectProject(project.id); setView('dashboard'); }}
        className="block w-full space-y-1.5 px-4 py-2.5 text-left hover:bg-hover">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{project.name}</span>
          <StatusBadge status={project.status} className="shrink-0" />
        </div>
        {project.description && <p className="truncate text-[11.5px] text-muted">{project.description}</p>}
        <div className="flex items-center gap-2">
          <Progress value={ratio} color={statusMeta(project.status).color} />
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted">{project.tasksCompleted}/{project.tasksTotal} · {Math.round(ratio * 100)}%</span>
        </div>
        <p className="flex flex-wrap gap-x-3 text-[11px] text-faint">
          <span>{project.activeAgents} active agent{project.activeAgents === 1 ? '' : 's'}</span>
          {project.failedTasks > 0 && <span className="text-st-failed">{project.failedTasks} failed</span>}
          <span>updated {timeAgo(project.updatedAt)}</span>
        </p>
      </button>
    </li>
  );
}

export function ActiveProjects({ projects }: { projects: OverviewProject[] }) {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Active Projects">
        <button type="button" onClick={() => setView('projects')} className="rounded text-[12px] text-brand hover:underline">View all →</button>
      </PanelHeader>
      {projects.length ? (
        <ul className="divide-y divide-line-soft">{projects.map((project) => <ProjectRow key={project.id} project={project} />)}</ul>
      ) : (
        <EmptyState title="No projects yet">Create a project to see its progress here.</EmptyState>
      )}
    </Panel>
  );
}
