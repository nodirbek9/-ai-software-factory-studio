import type { AgentSession, ProcessBudgetSnapshot, WorkspaceLayout } from '@asf/shared';
import { panelIds, reopenSession, setPanelSession } from './layout';

// Layout helpers that layout.ts (the pure engine) does not cover: panel kinds and placing sessions.

export function setPanelKind(layout: WorkspaceLayout, panelId: string, kind: 'session' | 'orchestrator'): WorkspaceLayout {
  const panel = layout.panels[panelId];
  if (!panel || panel.kind === kind) return layout;
  return { ...layout, panels: { ...layout.panels, [panelId]: { ...panel, kind, sessionId: null, tab: 'chat' } } };
}

/** Shows a session in `targetPanelId` (an empty panel), or in the first empty panel, or in a new split panel. */
export function placeSession(layout: WorkspaceLayout, sessionId: string, targetPanelId?: string): WorkspaceLayout {
  if (targetPanelId && layout.panels[targetPanelId]) {
    const target = layout.panels[targetPanelId];
    return setPanelSession(target.kind === 'session' ? layout : setPanelKind(layout, targetPanelId, 'session'), targetPanelId, sessionId);
  }
  return reopenSession(layout, sessionId);
}

/** Sessions that are not shown in any panel and not closed: the "Start a session" picker lists these. */
export function pickableSessions(layout: WorkspaceLayout, sessions: AgentSession[]): AgentSession[] {
  const shown = new Set(Object.values(layout.panels).map((p) => p.sessionId));
  return sessions.filter((s) => s.status !== 'closed' && !shown.has(s.id));
}

/** Reading-order index (1-based) of a panel, used for the Ctrl+1…8 shortcut hint. */
export function panelNumber(layout: WorkspaceLayout, panelId: string): number {
  return panelIds(layout).indexOf(panelId) + 1;
}

/** Position in the process-budget queue: the live budget wins over the (possibly older) session field. */
export function queuePosition(session: AgentSession, budget: ProcessBudgetSnapshot | null): number | null {
  const queued = budget?.queued.find((owner) => owner.kind === 'session' && owner.id === session.id);
  return queued ? queued.position : session.queuePosition;
}

/** Removes terminal control sequences (colors, cursor moves, OSC titles) from command output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}

export function formatElapsed(startIso: string | null, now: number): string {
  if (!startIso) return '0:00';
  const seconds = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
