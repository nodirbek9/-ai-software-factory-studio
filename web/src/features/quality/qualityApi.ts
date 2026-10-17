import type { Approval, Finding, FindingQuery, FindingsResponse, QualityOverview, Task, UpdateFindingInput } from '@asf/shared';
import { api, patch, post } from '@/lib/api';

const enc = encodeURIComponent;

/** `GET /api/v2/projects/:id/quality?runId=` — a missing runId means the project's current run. */
export function getQuality(projectId: string, runId?: string): Promise<QualityOverview> {
  const query = runId ? `?runId=${enc(runId)}` : '';
  return api<QualityOverview>(`/api/v2/projects/${enc(projectId)}/quality${query}`);
}

/** `GET /api/v2/findings?…` — only the set filters are sent. */
export function listFindings(query: FindingQuery = {}): Promise<FindingsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return api<FindingsResponse>(`/api/v2/findings${text ? `?${text}` : ''}`);
}

export async function updateFinding(id: string, input: UpdateFindingInput): Promise<Finding> {
  return (await patch<{ finding: Finding }>(`/api/v2/findings/${enc(id)}`, input)).finding;
}

/** Creates a real `implement` task in the project's current run; the caller has already confirmed. */
export async function createFixTask(id: string): Promise<Task> {
  return (await post<{ task: Task }>(`/api/v2/findings/${enc(id)}/fix-task`, { confirm: true })).task;
}

/** Requests an `npm audit` — it only runs after the owner approves it (network access). */
export async function requestAudit(projectId: string): Promise<Approval> {
  return (await post<{ approval: Approval }>(`/api/v2/projects/${enc(projectId)}/quality/audit`, { confirm: true })).approval;
}
