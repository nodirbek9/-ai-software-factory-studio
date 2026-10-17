import type { TaskDetail, TaskDiff, TaskQuery, TasksResponse } from '@asf/shared';
import { api, post } from '@/lib/api';

const enc = encodeURIComponent;

/** `GET /api/v2/tasks?…` — only the set filters are sent; the server defaults runId to the active run. */
export function listTasks(query: TaskQuery = {}): Promise<TasksResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return api<TasksResponse>(`/api/v2/tasks${text ? `?${text}` : ''}`);
}

export function getTaskDetail(id: string): Promise<TaskDetail> {
  return api<TaskDetail>(`/api/v2/tasks/${enc(id)}`);
}

export function getTaskDiff(id: string): Promise<TaskDiff> {
  return api<TaskDiff>(`/api/v2/tasks/${enc(id)}/diff`);
}

/** V1 rule: the server only retries failed or cancelled tasks. */
export async function retryTask(id: string): Promise<void> {
  await post<unknown>(`/api/tasks/${enc(id)}/retry`, {});
}

export async function cancelTask(id: string): Promise<void> {
  await post<unknown>(`/api/tasks/${enc(id)}/cancel`, {});
}
