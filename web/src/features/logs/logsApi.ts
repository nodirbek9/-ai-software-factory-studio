import type { AgentSession, EventsPage, LogQuery } from '@asf/shared';
import { api } from '@/lib/api';

const enc = encodeURIComponent;

/** Events fetched per request (server cap is 500). */
export const LOG_PAGE_SIZE = 200;

/** `GET /api/v2/events?…` — only the set filters are sent. Newest events come first; `before` pages backwards. */
export function fetchEvents(query: LogQuery = {}): Promise<EventsPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return api<EventsPage>(`/api/v2/events${text ? `?${text}` : ''}`);
}

/** The sessions of one project (for the session filter). Tolerates both `[...]` and `{ sessions: [...] }`. */
export async function listSessions(projectId: string): Promise<AgentSession[]> {
  const result = await api<unknown>(`/api/v2/projects/${enc(projectId)}/sessions`);
  const list = Array.isArray(result) ? result : (result as { sessions?: unknown } | null)?.sessions;
  return Array.isArray(list) ? (list as AgentSession[]) : [];
}
