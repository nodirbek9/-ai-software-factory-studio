import { Plus, Workflow } from 'lucide-react';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { Button } from '@/components/ui/primitives';
import { useSessions } from './sessionsStore';
import { pickableSessions, setPanelKind } from './panelActions';
import { setPanelSession } from './layout';
import { PanelFrame } from './PanelFrame';
import { updateLayout, useWorkspaceApi } from './workspaceContext';

/** "Start a session" picker: shows an existing session here, creates a new one, or turns the panel into the orchestrator. */
export function EmptyPanel({ panelId, missingSessionId }: { panelId: string; missingSessionId: string | null }) {
  const { openNewSession } = useWorkspaceApi();
  const layout = useSessions((s) => s.layout);
  const sessions = useSessions((s) => s.sessions);
  const loaded = useSessions((s) => s.sessionsLoaded);
  const pickable = layout ? pickableSessions(layout, sessions) : [];
  const hasOrchestrator = layout ? Object.values(layout.panels).some((p) => p.kind === 'orchestrator') : false;

  return (
    <PanelFrame panelId={panelId} titleText="Empty panel" icon={<Plus size={16} />} hue="var(--color-faint)" title="Start a session">
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        {missingSessionId && loaded && (
          <p role="status" className="rounded-md border border-st-waiting/30 bg-st-waiting/10 px-2.5 py-1.5 text-[12px] text-st-waiting">
            The session that was shown here no longer exists. Pick another one.
          </p>
        )}
        <p className="text-[13px] text-muted">
          Panels cost nothing until you send a message — no agent process starts when a session is created or shown.
        </p>
        {pickable.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-[12px] font-medium text-muted">Existing sessions</h3>
            <ul className="space-y-1" aria-label="Existing sessions">
              {pickable.map((session) => {
                const Icon = ROLE_ICON[session.role];
                return (
                  <li key={session.id}>
                    <button type="button" onClick={() => updateLayout((l) => setPanelSession(l, panelId, session.id))}
                      className="flex w-full items-center gap-2 rounded-md border border-line-soft px-2.5 py-1.5 text-left text-[13px] hover:bg-ink-800">
                      <Icon size={14} style={{ color: ROLE_HUE[session.role] }} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">{AGENT_ROLE_INFO[session.role].name} · {session.status}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => openNewSession(panelId)}><Plus size={13} aria-hidden="true" /> New session here</Button>
          <Button size="sm" disabled={hasOrchestrator} title={hasOrchestrator ? 'The orchestrator is already open in another panel' : undefined}
            onClick={() => updateLayout((l) => setPanelKind(l, panelId, 'orchestrator'))}>
            <Workflow size={13} aria-hidden="true" /> Studio Orchestrator
          </Button>
        </div>
      </div>
    </PanelFrame>
  );
}
