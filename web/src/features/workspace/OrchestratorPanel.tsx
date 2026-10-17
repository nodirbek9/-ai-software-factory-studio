import { useMemo } from 'react';
import { Pause, Play, Square, Workflow } from 'lucide-react';
import type { StudioEvent } from '@asf/shared';
import { Button, StatusBadge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { PanelFrame } from './PanelFrame';
import { useSessions } from './sessionsStore';

/** Event types the scheduler timeline shows (AGENT_WORKSPACE_SPEC.md §10). */
export function isOrchestratorEvent(event: StudioEvent): boolean {
  return /^(task|run|provider|git)\./.test(event.type);
}

const LEVEL_TEXT: Record<StudioEvent['level'], string> = {
  debug: 'text-faint', info: 'text-muted', warn: 'text-st-waiting', error: 'text-st-failed',
};

const TIMELINE_LIMIT = 60;
const CANCEL_CONFIRM = 'Cancel this project run? Running tasks are cancelled; completed work stays on the integration branch.';

export function useOrchestratorEvents(limit = TIMELINE_LIMIT): StudioEvent[] {
  const events = useStudio((s) => s.events);
  const projectId = useStudio((s) => s.currentProjectId);
  return useMemo(() => events.filter((event) => event.projectId === projectId && isOrchestratorEvent(event)).slice(-limit), [events, projectId, limit]);
}

export function OrchestratorPanel({ panelId }: { panelId: string }) {
  const status = useStudio((s) => s.snapshot?.project.status);
  const timeline = useOrchestratorEvents();
  const budget = useSessions((s) => s.budget);
  const counts = useMemo(() => ({
    fallbacks: timeline.filter((e) => e.type === 'provider.fallback').length,
    limits: timeline.filter((e) => e.type === 'provider.limit').length,
    exhausted: timeline.filter((e) => e.type === 'task.fix_exhausted').length,
    fixRounds: timeline.filter((e) => e.type.startsWith('task.fix_') && e.type !== 'task.fix_exhausted').length,
  }), [timeline]);

  const canPause = status === 'planning' || status === 'running' || status === 'awaiting_approval';
  const canCancel = canPause || status === 'paused';
  const store = useStudio.getState;

  return (
    <PanelFrame
      panelId={panelId} titleText="Studio Orchestrator" icon={<Workflow size={16} />} hue="var(--color-brand-violet)" title="Studio Orchestrator"
      pill={status ? <StatusBadge status={status} /> : undefined}
      actions={(
        <>
          {status === 'paused'
            ? <Button size="sm" variant="ghost" onClick={() => void store().resume()}><Play size={11} aria-hidden="true" /> Resume</Button>
            : <Button size="sm" variant="ghost" disabled={!canPause} title={canPause ? undefined : 'No active run to pause'} onClick={() => void store().pause()}>
              <Pause size={11} aria-hidden="true" /> Pause
            </Button>}
          <Button size="sm" variant="ghost" disabled={!canCancel} title={canCancel ? undefined : 'No active run to cancel'}
            onClick={() => { if (window.confirm(CANCEL_CONFIRM)) void store().cancelProject(); }}>
            <Square size={11} aria-hidden="true" /> Cancel
          </Button>
        </>
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <section aria-label="Process budget" className="shrink-0 space-y-1.5 border-b border-line-soft px-3 py-2 text-[12.5px]">
          <h3 className="text-[12px] font-medium text-muted">Process slots</h3>
          {budget ? (
            <>
              <p><span className="tabular-nums">{budget.running.length} / {budget.limit}</span> slots in use · <span className="tabular-nums">{budget.queued.length}</span> queued</p>
              {budget.running.length > 0 && (
                <ul className="text-muted">{budget.running.map((owner) => <li key={`${owner.kind}:${owner.id}`} className="truncate">▶ {owner.label} <span className="text-faint">({owner.kind})</span></li>)}</ul>
              )}
              {budget.queued.length > 0 && (
                <ol className="text-muted">{budget.queued.map((owner) => <li key={`${owner.kind}:${owner.id}`} className="truncate">#{owner.position} {owner.label} <span className="text-faint">({owner.kind})</span></li>)}</ol>
              )}
            </>
          ) : <p className="text-muted">Budget not loaded yet.</p>}
          <p className="text-[11.5px] text-muted">
            Decisions: {counts.fallbacks} provider fallback(s) · {counts.limits} limit hit(s) · {counts.fixRounds} fix event(s) · {counts.exhausted} exhausted
          </p>
        </section>
        <section aria-label="Scheduler timeline" className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <h3 className="mb-1.5 text-[12px] font-medium text-muted">Timeline</h3>
          {!timeline.length && <p className="text-[12.5px] text-muted">No scheduler events for this project yet.</p>}
          <ol className="space-y-1.5">
            {[...timeline].reverse().map((event) => (
              <li key={event.id} className="flex gap-2 text-[12px]">
                <time className="shrink-0 tabular-nums text-faint" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString([], { hour12: false })}</time>
                <span className={cn('min-w-0 break-words', LEVEL_TEXT[event.level])}><span className="text-faint">{event.type}</span> {event.message}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </PanelFrame>
  );
}
