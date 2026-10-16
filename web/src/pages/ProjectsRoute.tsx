import { lazy, useEffect, useState } from 'react';
import { hashParam, viewFromHash } from '@/store/studio';
import { Projects } from '@/pages/Projects';

const ProjectDetail = lazy(() => import('@/pages/ProjectDetail'));

/** `#/projects` = the project list, `#/projects/:id` = one project's detail page (Phase 5). */
export function ProjectsRoute() {
  const [projectId, setProjectId] = useState(() => hashParam(window.location.hash));
  useEffect(() => {
    const onHash = () => { if (viewFromHash(window.location.hash) === 'projects') setProjectId(hashParam(window.location.hash)); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return projectId ? <ProjectDetail projectId={projectId} /> : <Projects />;
}
