import { createContext, useContext } from 'react';
import type { WorkspaceLayout } from '@asf/shared';
import { useSessions } from './sessionsStore';

export interface WorkspaceApi {
  /** Opens the New Session dialog; the created session goes to `panelId` when given. */
  openNewSession: (panelId?: string) => void;
  activePanelId: string | null;
  setActivePanel: (panelId: string) => void;
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspaceApi(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error('Workspace components must be rendered inside the Workspace page.');
  return api;
}

/** Applies a pure layout transformation to the current layout; the store persists it (debounced). */
export function updateLayout(change: (layout: WorkspaceLayout) => WorkspaceLayout): void {
  const { layout, setLayout } = useSessions.getState();
  if (!layout) return;
  const next = change(layout);
  if (next !== layout) setLayout(next);
}
