import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, History, PanelRight, Plus } from 'lucide-react';
import { Button, EmptyState, Select, Skeleton } from '@/components/ui/primitives';
import { useStudio } from '@/store/studio';
import { cn } from '@/lib/utils';
import { CoordinationDrawer } from '@/features/workspace/CoordinationDrawer';
import { LayoutView } from '@/features/workspace/LayoutView';
import { NewSessionDialog } from '@/features/workspace/NewSessionDialog';
import { PanelMenu, type MenuItem } from '@/features/workspace/PanelMenu';
import { StatusBar } from '@/features/workspace/StatusBar';
import { WorkspacePanel } from '@/features/workspace/SessionPanel';
import { WORKSPACE_PRESETS, applyPreset, panelIds, reopenSession, resizeSplit, restorePanel, toggleMaximize } from '@/features/workspace/layout';
import { placeSession } from '@/features/workspace/panelActions';
import { useSessions } from '@/features/workspace/sessionsStore';
import { WorkspaceContext, updateLayout, type WorkspaceApi } from '@/features/workspace/workspaceContext';

function downloadLayout(projectName: string) {
  const layout = useSessions.getState().layout;
  if (!layout) return;
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(layout, null, 2))}`;
  link.download = `workspace-layout-${projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'project'}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function WorkspaceSkeleton() {
  return (
    <div className="grid flex-1 grid-cols-2 gap-2 p-3" aria-busy="true" aria-label="Loading workspace">
      <Skeleton className="h-full" /><Skeleton className="h-full" />
    </div>
  );
}

/** Minimized panels and recently closed sessions, above the status bar. */
function Dock() {
  const layout = useSessions((s) => s.layout);
  const sessions = useSessions((s) => s.sessions);
  if (!layout || (!layout.minimized.length && !layout.recentlyClosed.length)) return null;
  const labelOf = (panelId: string): string => {
    const panel = layout.panels[panelId];
    if (!panel) return panelId;
    if (panel.kind === 'orchestrator') return 'Studio Orchestrator';
    return sessions.find((s) => s.id === panel.sessionId)?.title ?? 'Empty panel';
  };
  const closed: MenuItem[] = layout.recentlyClosed.map((entry) => ({
    id: entry.sessionId, label: entry.title, onSelect: () => updateLayout((l) => reopenSession(l, entry.sessionId)),
    disabledReason: sessions.find((s) => s.id === entry.sessionId)?.status === 'closed' ? 'This session was closed' : undefined,
  }));
  return (
    <nav aria-label="Dock" className="flex shrink-0 items-center gap-2 border-t border-line-soft bg-sidebar px-3 py-1">
      <span className="text-[11px] text-faint">Minimized</span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {layout.minimized.map((panelId) => (
          <button key={panelId} type="button" onClick={() => updateLayout((l) => restorePanel(l, panelId))} title="Restore panel"
            className="max-w-[180px] truncate rounded-md border border-line bg-ink-850 px-2 py-0.5 text-[12px] text-muted hover:text-text">
            {labelOf(panelId)}
          </button>
        ))}
      </div>
      {closed.length > 0 && <PanelMenu label="Recently closed" items={closed} icon={<History size={14} aria-hidden="true" />} />}
    </nav>
  );
}

function NoProject() {
  const setView = useStudio((s) => s.setView);
  return (
    <EmptyState title="No project selected" icon={<Plus size={22} />}>
      <p>Agent sessions belong to a project. Select or create a project first.</p>
      <Button className="mt-3" variant="primary" onClick={() => setView('projects')}>Open Projects</Button>
    </EmptyState>
  );
}

export function Workspace() {
  const projectId = useStudio((s) => s.currentProjectId);
  const projectName = useStudio((s) => s.snapshot?.project.name ?? 'project');
  const layout = useSessions((s) => s.layout);
  const sessions = useSessions((s) => s.sessions);
  const sessionsError = useSessions((s) => s.sessionsError);
  const layoutError = useSessions((s) => s.layoutError);
  const [dialog, setDialog] = useState<{ open: boolean; panelId?: string }>({ open: false });
  const [activePanelId, setActivePanel] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) { useSessions.getState().reset(); return undefined; }
    void useSessions.getState().load(projectId);
    return () => { void useSessions.getState().flushLayout(); };
  }, [projectId]);

  // The panel that Ctrl+Shift+M acts on: the last one touched, else the first one on screen.
  const targetPanel = useCallback((): string | null => {
    const current = useSessions.getState().layout;
    if (!current) return null;
    const ids = panelIds(current);
    return activePanelId && ids.includes(activePanelId) ? activePanelId : ids[0] ?? null;
  }, [activePanelId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = useSessions.getState().layout;
      if (!current) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key === '.') {
        event.preventDefault();
        updateLayout((l) => ({ ...l, drawer: { ...l.drawer, open: !l.drawer.open } }));
      } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        const id = targetPanel();
        if (id) updateLayout((l) => toggleMaximize(l, id));
      } else if (event.key === 'Escape' && current.maximized && !event.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) {
        updateLayout((l) => ({ ...l, maximized: null }));
      } else if (ctrl && !event.shiftKey && !event.altKey && /^[1-8]$/.test(event.key)) {
        const frame = document.querySelectorAll<HTMLElement>('[data-panel-frame]')[Number(event.key) - 1];
        if (!frame) return;
        event.preventDefault();
        (frame.querySelector<HTMLElement>('textarea') ?? frame).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [targetPanel]);

  const api = useMemo<WorkspaceApi>(() => ({
    openNewSession: (panelId) => setDialog({ open: true, panelId }),
    activePanelId,
    setActivePanel,
  }), [activePanelId]);

  if (!projectId) return <NoProject />;

  const titleOf = (sessionId: string) => sessions.find((s) => s.id === sessionId)?.title ?? sessionId;

  return (
    <WorkspaceContext.Provider value={api}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-tight">Multi-Agent Workspace</h1>
            <p className="text-[12.5px] text-muted">Parallel agent sessions for {projectName}. No process runs until you send a message.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <span>Layout</span>
              <Select aria-label="Layout preset" className="w-28" disabled={!layout}
                value={layout ? String(layout.preset) : '1'}
                onChange={(event) => {
                  const preset = WORKSPACE_PRESETS.find((p) => String(p) === event.target.value);
                  if (preset) updateLayout((l) => applyPreset(l, preset, { titleOf }));
                }}>
                {layout?.preset === 'custom' && <option value="custom" disabled>Custom</option>}
                {WORKSPACE_PRESETS.map((p) => <option key={p} value={p}>{p} {p === 1 ? 'panel' : 'panels'}</option>)}
              </Select>
            </label>
            <Button size="md" aria-pressed={layout?.drawer.open ?? false} disabled={!layout} title="Coordination drawer (Ctrl+.)"
              onClick={() => updateLayout((l) => ({ ...l, drawer: { ...l.drawer, open: !l.drawer.open } }))}
              className={cn(layout?.drawer.open && 'border-brand bg-brand/15')}>
              <PanelRight size={14} aria-hidden="true" /> Coordination
            </Button>
            <Button disabled={!layout} onClick={() => downloadLayout(projectName)} title="Download the layout as JSON">
              <Download size={14} aria-hidden="true" /> Export layout
            </Button>
            <Button variant="primary" disabled={!layout} onClick={() => setDialog({ open: true })}>
              <Plus size={14} aria-hidden="true" /> New Session
            </Button>
          </div>
        </div>
        {(sessionsError || layoutError) && (
          <p role="alert" className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-st-waiting/30 bg-st-waiting/10 px-3 py-1.5 text-[12.5px] text-st-waiting">
            <span>{sessionsError ? `Could not load sessions: ${sessionsError}` : layoutError}</span>
            {sessionsError && <button type="button" className="underline" onClick={() => void useSessions.getState().reloadSessions()}>Retry</button>}
          </p>
        )}
        {!layout ? <WorkspaceSkeleton /> : (
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 border-y border-line-soft">
              <LayoutView layout={layout} renderPanel={(id) => <WorkspacePanel panelId={id} />}
                onResize={(path, sizes) => updateLayout((l) => resizeSplit(l, path, sizes))} />
            </div>
            {layout.drawer.open && <CoordinationDrawer tab={layout.drawer.tab} width={layout.drawer.width} projectId={projectId} />}
          </div>
        )}
        <Dock />
        <StatusBar />
        <NewSessionDialog open={dialog.open} onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
          onCreated={(session) => updateLayout((l) => placeSession(l, session.id, dialog.panelId))} />
      </div>
    </WorkspaceContext.Provider>
  );
}
