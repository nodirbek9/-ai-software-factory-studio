import type { ProjectSnapshot, RepoOverview } from '@asf/shared';
import { ApiError, api, post } from '@/lib/api';

// Workflows and runs already have a client; the project pages reuse it instead of duplicating it.
export { listRuns, listWorkflows, startRun } from '@/features/workflows/workflowsApi';

const enc = encodeURIComponent;

export function getSnapshot(projectId: string): Promise<ProjectSnapshot> {
  return api<ProjectSnapshot>(`/api/projects/${enc(projectId)}`);
}

export function pauseProject(projectId: string): Promise<unknown> {
  return post<unknown>(`/api/projects/${enc(projectId)}/pause`, {});
}

export function resumeProject(projectId: string): Promise<unknown> {
  return post<unknown>(`/api/projects/${enc(projectId)}/resume`, {});
}

export function cancelProject(projectId: string): Promise<unknown> {
  return post<unknown>(`/api/projects/${enc(projectId)}/cancel`, {});
}

/** The delivery report as Markdown text; null while the server has not generated one (404). */
export async function getReport(projectId: string): Promise<string | null> {
  try {
    return await api<string>(`/api/projects/${enc(projectId)}/report.md`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
}

export function getRepo(projectId: string): Promise<RepoOverview> {
  return api<RepoOverview>(`/api/v2/projects/${enc(projectId)}/repo`);
}
