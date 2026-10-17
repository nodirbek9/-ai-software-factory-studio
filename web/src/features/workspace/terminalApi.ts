import { api, getToken } from '@/lib/api';

/** An owner terminal (Phase 3c): PowerShell in an edit session's own worktree. */
export interface TerminalInfo {
  id: string;
  sessionId: string;
  projectId: string;
  cwd: string;
  openedAt: string;
}

export interface TerminalList {
  terminals: TerminalInfo[];
  /** Why terminals cannot be opened on this studio (e.g. reachable from other computers), or null. */
  unavailableReason: string | null;
}

export const MAX_TERMINALS = 2;

export function listTerminals(): Promise<TerminalList> {
  return api<TerminalList>('/api/v2/terminals');
}

export function openTerminal(sessionId: string, cols: number, rows: number): Promise<TerminalInfo> {
  return api<TerminalInfo>(`/api/v2/sessions/${encodeURIComponent(sessionId)}/terminal`, { method: 'POST', json: { confirm: true, cols, rows } });
}

export function closeTerminal(terminalId: string): Promise<unknown> {
  return api<unknown>(`/api/v2/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE', json: {} });
}

/** Same origin as the page; the token (when the studio needs one) goes in the query, browsers cannot set WS headers. */
export function terminalSocketUrl(terminalId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  return `${scheme}://${window.location.host}/api/v2/terminals/${encodeURIComponent(terminalId)}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
