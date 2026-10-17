import type { UsageDailyResponse } from '@asf/shared';
import { api } from '@/lib/api';

/** `GET /api/v2/usage/daily?days=&projectId=` — rows grouped by day × provider × model × project. */
export function getUsageDaily(days: number, projectId?: string): Promise<UsageDailyResponse> {
  const params = new URLSearchParams({ days: String(days) });
  if (projectId) params.set('projectId', projectId);
  return api<UsageDailyResponse>(`/api/v2/usage/daily?${params.toString()}`);
}
