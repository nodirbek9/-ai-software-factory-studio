const TOKEN_KEY = 'asf.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable — the token lives only for this page load
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const response = await fetch(path, { ...init, headers, body });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
    throw new ApiError(payload.error ?? `${response.status} ${response.statusText}`, response.status, payload.details);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? response.json() : response.text()) as Promise<T>;
}

export const post = <T>(path: string, json: unknown = {}): Promise<T> => api<T>(path, { method: 'POST', json });
export const put = <T>(path: string, json: unknown): Promise<T> => api<T>(path, { method: 'PUT', json });
export const patch = <T>(path: string, json: unknown): Promise<T> => api<T>(path, { method: 'PATCH', json });

export function eventsUrl(after: number): string {
  const params = new URLSearchParams();
  if (after) params.set('after', String(after));
  const token = getToken();
  if (token) params.set('token', token);
  const query = params.toString();
  return `/api/events${query ? `?${query}` : ''}`;
}
