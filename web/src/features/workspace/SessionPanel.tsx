import { lazy, Suspense, useEffect, useState } from 'react';
import { RotateCcw, Square } from 'lucide-react';
import { AGENT_ROLE_INFO, type AgentSession, type WorkspacePanelTab } from '@asf/shared';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { Button, StatusDot } from '@/components/ui/primitives';
import { cn, statusMeta } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { ChatTab } from './ChatTab';
import { EmptyPanel } from './EmptyPanel';
import { OrchestratorPanel } from './OrchestratorPanel';
import { setPanelTab } from './layout';
import { formatElapsed, queuePosition } from './panelActions';
import { PanelFrame } from './PanelFrame';
import type { MenuItem } from './PanelMenu';
import { ActivityTab, ChangesTab, FilesTab, OutputTab, TaskTab } from './SessionTabs';
import { useSessions, watchSession, type SessionAction, type TurnPage } from './sessionsStore';

/** xterm.js loads only when a Terminal tab is shown (Phase 3c). */
const TerminalTab = lazy(() => import('./TerminalTab'));
import { updateLayout } from './workspaceContext';

const NO_PAGE: TurnPage = { items: [], nextBefore: null, loading: false, loaded: false, error: null };

const TAB_LABELS: Record<WorkspacePanelTab, string> = {
  chat: 'Chat', activity: 'Activity', changes: 'Changes', files: 'Files', output: 'Output', task: 'Task', terminal: 'Terminal',
};

export function availableTabs(session: AgentSession): WorkspacePanelTab[] {
  const tabs: WorkspacePanelTab[] = ['chat', 'activity'];
  if (session.mode === 'edit') tabs.push('changes');
  tabs.push('files', 'output');
  if (session.taskId) tabs.push('task');
  // Owner terminal (Phase 3c): only in an edit session's own worktree.
  if (session.mode === 'edit' && session.cwdKind === 'own-worktree' && session.status !== 'closed') tabs.push('terminal');
  return tabs;
}

const PILL_STATUS: Record<AgentSession['status'], string> = {
  idle: 'idle', queued: 'waiting_approval', running: 'running', failed: 'failed', stopped: 'cancelled', closed: 'cancelled',
};

function StatusPill({ session }: { session: AgentSession }) {
  const budget = useSessions((s) => s.budget);
  const page = useSessions((s) => s.turns[session.id]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (session.status !== 'running') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session.status]);

  const meta = statusMeta(PILL_STATUS[session.status]);
  let label: string;
  if (session.status === 'queued') {
    const position = queuePosition(session, budget);
    label = position !== null ? `Queued #${position}` : 'Queued';
  } else if (session.status === 'running') {
    const open = page?.items.findLast((turn) => turn.author === 'user');
    label = `Running ${formatElapsed(open?.startedAt ?? session.lastActivityAt, now)}`;
  } else {
    label = { idle: 'Idle', failed: 'Failed', stopped: 'Stopped', closed: 'Closed' }[session.status];
  }
  return (
    <span data-session-status={session.status} title={session.lastError ?? undefined}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', meta.text)}
      style={{ borderColor: `color-mix(in srgb, ${meta.color} 35%, transparent)`, background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}>
      <StatusDot status={PILL_STATUS[session.status]} className="h-1.5 w-1.5" />
      {label}
    </span>
  );
}

function Chip({ children, title }: { children: string; title?: string }) {
  return <span title={title} className="rounded-md border border-line-soft bg-ink-950 px-1.5 py-0.5 text-[11px] text-muted">{children}</span>;
}

const CONFIRM: Partial<Record<SessionAction, (s: AgentSession) => string>> = {
  checkpoint: (s) => `Commit the current changes of "${s.title}" as a checkpoint on ${s.branch ?? 'its branch'}?`,
  sync: (s) => `Merge the integration branch into ${s.branch ?? 'the session branch'}? Conflicts will need to be resolved.`,
  merge: (s) => `Merge ${s.branch ?? 'the session branch'} into the integration branch? The agent's changes become part of the project.`,
  discard: (s) => `Discard the worktree of "${s.title}"? Uncommitted changes are lost. The branch ${s.branch ?? ''} is kept.`,
};

function SessionBody({ panelId, session, tab }: { panelId: string; session: AgentSession; tab: WorkspacePanelTab }) {
  const page = useSessions((s) => s.turns[session.id]) ?? NO_PAGE;
  const live = useSessions((s) => s.live[session.id]) ?? '';
  const tabs = availableTabs(session);
  const current = tabs.includes(tab) ? tab : 'chat';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Session views" className="flex shrink-0 gap-0.5 border-b border-line-soft px-2">
        {tabs.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={current === id} id={`${panelId}-tab-${id}`}
            onClick={() => updateLayout((layout) => setPanelTab(layout, panelId, id))}
            className={cn('-mb-px border-b-2 px-2.5 py-1.5 text-[12px]', current === id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text')}>
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-labelledby={`${panelId}-tab-${current}`} className="min-h-0 flex-1">
        {current === 'chat' && <ChatTab session={session} page={page} live={live} />}
        {current === 'activity' && <ActivityTab page={page} />}
        {current === 'changes' && <ChangesTab session={session} />}
        {current === 'files' && <FilesTab session={session} />}
        {current === 'output' && <OutputTab session={session} page={page} />}
        {current === 'task' && <TaskTab session={session} />}
        {current === 'terminal' && <Suspense fallback={<p className="p-3 text-[12px] text-muted">Loading terminal…</p>}><TerminalTab session={session} /></Suspense>}
      </div>
    </div>
  );
}

function LiveSessionPanel({ panelId, session, tab }: { panelId: string; session: AgentSession; tab: WorkspacePanelTab }) {
  const providerLabel = useStudio((s) => s.providers.find((p) => p.id === session.providerId)?.label ?? session.providerId);
  const turnsLoaded = useSessions((s) => s.turns[session.id]?.loaded ?? false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const Icon = ROLE_ICON[session.role];
  const busy = session.status === 'queued' || session.status === 'running';
  const edit = session.mode === 'edit';

  // A visible panel buffers live output and shows the transcript; nothing here starts an agent process.
  useEffect(() => watchSession(session.id), [session.id]);
  useEffect(() => {
    if (!turnsLoaded) void useSessions.getState().loadTurns(session.id);
  }, [session.id]);

  const run = async (action: SessionAction, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      await useSessions.getState().runAction(session.id, action, confirmText ? { confirm: true } : {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const closeSession = async () => {
    if (!window.confirm(`Close "${session.title}"? ${edit ? 'Merge or discard its worktree first if the changes matter. ' : ''}The transcript stays available.`)) return;
    setError(null);
    try {
      await useSessions.getState().closeSession(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveTitle = async () => {
    const title = renaming?.trim();
    setRenaming(null);
    if (!title || title === session.title) return;
    try {
      await useSessions.getState().renameSession(session.id, title);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const editOnly = edit ? undefined : 'Only edit sessions have a worktree';
  const items: MenuItem[] = [
    { id: 'rename', label: 'Rename', onSelect: () => setRenaming(session.title) },
    { id: 'checkpoint', label: 'Checkpoint (commit)', disabledReason: editOnly, onSelect: () => void run('checkpoint', CONFIRM.checkpoint!(session)) },
    { id: 'sync', label: 'Sync from integration', disabledReason: editOnly, onSelect: () => void run('sync', CONFIRM.sync!(session)) },
    { id: 'merge', label: 'Merge into integration', disabledReason: editOnly, onSelect: () => void run('merge', CONFIRM.merge!(session)) },
    { id: 'discard', label: 'Discard worktree', danger: true, disabledReason: editOnly, onSelect: () => void run('discard', CONFIRM.discard!(session)) },
    { id: 'close', label: 'Close session', danger: true, separatorBefore: true, disabledReason: session.status === 'closed' ? 'Already closed' : undefined, onSelect: () => void closeSession() },
  ];

  const title = renaming !== null ? (
    <input autoFocus aria-label="Session title" value={renaming} onChange={(event) => setRenaming(event.target.value)}
      onBlur={() => void saveTitle()}
      onKeyDown={(event) => { if (event.key === 'Enter') void saveTitle(); if (event.key === 'Escape') setRenaming(null); }}
      className="h-6 w-full rounded border border-brand bg-ink-950 px-1.5 text-[13px] outline-none" />
  ) : <span title={`${AGENT_ROLE_INFO[session.role].name} · #${session.number}`}>{session.title}</span>;

  return (
    <PanelFrame
      panelId={panelId} titleText={session.title} icon={<Icon size={16} />} hue={ROLE_HUE[session.role]} title={title}
      pill={<StatusPill session={session} />}
      actions={(
        <>
          <Button size="sm" variant="ghost" disabled={!busy} onClick={() => void run('stop')} title={busy ? 'Stop the running turn' : 'Nothing is running'}>
            <Square size={11} aria-hidden="true" /> Stop
          </Button>
          <Button size="sm" variant="ghost" disabled={session.status === 'closed'} onClick={() => void run('restart')}
            title="Stop if needed, then resend the last user message">
            <RotateCcw size={11} aria-hidden="true" /> Restart
          </Button>
        </>
      )}
      menuItems={items}
      chips={(
        <>
          <Chip>{`${providerLabel} · ${session.model}${session.effort ? ` · ${session.effort}` : ''}`}</Chip>
          <Chip title={session.worktreePath ?? undefined}>{session.cwdKind === 'integration' ? 'cwd: integration (read-only)' : `cwd: session-${session.number}${session.branch ? ` · ${session.branch}` : ''}`}</Chip>
          <Chip title={session.continuity === 'native' ? 'The provider keeps the conversation' : 'The studio replays recent turns each time'}>
            {session.continuity === 'native' ? 'native continuity' : 'context replay'}
          </Chip>
        </>
      )}
    >
      {(error || session.lastError) && session.status !== 'running' && (
        <p role="alert" className="flex items-start justify-between gap-2 border-b border-st-failed/30 bg-st-failed/10 px-2.5 py-1.5 text-[12px] text-st-failed">
          <span className="min-w-0 break-words">{error ?? session.lastError}</span>
          {error && <button type="button" className="shrink-0 underline" onClick={() => setError(null)}>Dismiss</button>}
        </p>
      )}
      <SessionBody panelId={panelId} session={session} tab={tab} />
    </PanelFrame>
  );
}

/** One layout panel: orchestrator, a live session, or the empty "Start a session" picker. */
export function WorkspacePanel({ panelId }: { panelId: string }) {
  const panel = useSessions((s) => s.layout?.panels[panelId]);
  const session = useSessions((s) => (panel?.sessionId ? s.sessions.find((item) => item.id === panel.sessionId) : undefined));
  if (!panel) return null;
  if (panel.kind === 'orchestrator') return <OrchestratorPanel panelId={panelId} />;
  if (!session) return <EmptyPanel panelId={panelId} missingSessionId={panel.sessionId} />;
  return <LiveSessionPanel panelId={panelId} session={session} tab={panel.tab} />;
}
