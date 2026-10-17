import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { EmptyState, Panel, Select } from '@/components/ui/primitives';
import { RepoView } from '@/features/projects/RepoView';
import { useStudio } from '@/store/studio';

/** `#/repos` — read-only git overview of one project; defaults to the project selected in the header. */
export default function Repos() {
  const projects = useStudio((state) => state.projects);
  const currentProjectId = useStudio((state) => state.currentProjectId);
  const [picked, setPicked] = useState<string | null>(currentProjectId);

  useEffect(() => { if (currentProjectId) setPicked(currentProjectId); }, [currentProjectId]);

  const projectId = projects.some((project) => project.id === picked) ? picked : projects[0]?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Repos</h1>
        {projects.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-muted">
            Project
            <Select aria-label="Project" className="w-56" value={projectId ?? ''} onChange={(event) => setPicked(event.target.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </Select>
          </label>
        )}
      </div>
      {projectId ? <RepoView key={projectId} projectId={projectId} /> : (
        <Panel>
          <EmptyState icon={<GitBranch size={28} />} title="No projects yet">Create a project to see its branches and worktrees here.</EmptyState>
        </Panel>
      )}
    </div>
  );
}
