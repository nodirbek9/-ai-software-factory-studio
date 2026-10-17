import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { AGENT_ROLES, AGENT_ROLE_INFO, type AgentMessage, type OverviewResponse } from '@asf/shared';
import { Button, EmptyState, StatusBadge, Textarea } from '@/components/ui/primitives';
import { useV2 } from '@/features/home/useV2';
import { cn, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { deriveArtifacts, deriveHandoffs, latestTasks } from './coordination';
import { useOrchestratorEvents } from './OrchestratorPanel';
import { useSessions } from './sessionsStore';
import { updateLayout } from './workspaceContext';

type DrawerTab = 'coordination' | 'context' | 'artifacts';
const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'coordination', label: 'Agent Coordination' },
  { id: 'context', label: 'Shared Context' },
  { id: 'artifacts', label: 'Artifacts' },
];

const STAGE_STATUS: Record<string, string> = { waiting: 'waiting_approval', none: 'pending' };

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1.5 border-b border-line-soft px-3 py-2.5">
      <h3 className="flex items-center justify-between text-[12px] font-semibold text-muted">
        {title}{count !== undefined && <span className="rounded-full bg-ink-800 px-1.5 text-[10.5px] tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const roleName = (role: string) => AGENT_ROLE_INFO[role as keyof typeof AGENT_ROLE_INFO]?.name ?? role;

function CurrentWorkflow({ projectId }: { projectId: string }) {
  const overview = useV2<OverviewResponse>(`/api/v2/overview?projectId=${encodeURIComponent(projectId)}`);
  const stages = overview.data?.currentProject?.stages.filter((stage) => stage.status !== 'none') ?? [];
  return (
    <Section title="Current workflow" count={stages.length}>
      {overview.loading && !overview.data && <p className="text-[12px] text-muted">Loading…</p>}
      {overview.error && !overview.data && <p role="alert" className="text-[12px] text-st-failed">{overview.error}</p>}
      {overview.data && !stages.length && <p className="text-[12px] text-muted">No workflow stage has tasks yet.</p>}
      <ol className="space-y-1">
        {stages.map((stage) => (
          <li key={stage.role} className="flex items-center gap-2 text-[12.5px]">
            <span className="w-24 shrink-0 truncate">{roleName(stage.role)}</span>
            <StatusBadge status={STAGE_STATUS[stage.status] ?? stage.status} />
            <span className="min-w-0 flex-1 truncate text-muted" title={stage.currentTask?.title}>{stage.currentTask?.title ?? ''}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Handoffs() {
  const projectId = useStudio((s) => s.currentProjectId);
  const snapshotTasks = useStudio((s) => s.snapshot?.tasks);
  const events = useStudio((s) => s.events);
  const handoffs = useMemo(() => deriveHandoffs(latestTasks(snapshotTasks ?? [], events, projectId)), [snapshotTasks, events, projectId]);
  return (
    <Section title="Task handoffs" count={handoffs.length}>
      {!handoffs.length && <p className="text-[12px] text-muted">No task has started after a dependency completed yet.</p>}
      <ol className="space-y-1.5">
        {handoffs.slice(0, 20).map((handoff) => (
          <li key={handoff.id} className="text-[12.5px]" data-handoff={handoff.id}>
            <p className="flex items-center gap-1.5">
              <span>{roleName(handoff.from.role)}</span><ArrowRight size={12} className="text-faint" aria-hidden="true" /><span>{roleName(handoff.to.role)}</span>
              <StatusBadge status={handoff.to.status} className="ml-auto" />
            </p>
            <p className="truncate text-[11.5px] text-muted" title={handoff.from.title}>{handoff.from.title} · {timeAgo(handoff.at)}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Messages() {
  const messages = useStudio((s) => s.messages);
  const projectId = useStudio((s) => s.currentProjectId);
  useEffect(() => {
    for (const role of AGENT_ROLES) void useStudio.getState().loadMessages(role);
  }, [projectId]);
  const all = useMemo(() => {
    const flat: AgentMessage[] = Object.values(messages).flatMap((list) => list ?? []);
    return flat.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-20);
  }, [messages]);
  return (
    <Section title="Agent messages" count={all.length}>
      {!all.length && <p className="text-[12px] text-muted">No agent messages yet.</p>}
      <ul className="space-y-1.5">
        {all.map((message) => (
          <li key={`${message.role}:${message.id}`} className="text-[12.5px]">
            <span className="text-[11px] text-faint">{roleName(message.role)} · {message.direction} · {timeAgo(message.createdAt)}</span>
            <p className="line-clamp-3 whitespace-pre-wrap break-words">{message.content}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MessageAll() {
  const sessions = useSessions((s) => s.sessions).filter((s) => s.status !== 'closed');
  const [text, setText] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [state, setState] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    const forwardTo = sessions.filter((s) => ticked.has(s.id)).map((s) => s.id);
    setSending(true);
    setState(null);
    try {
      await useSessions.getState().postOrchestratorMessage(message, forwardTo);
      setText('');
      setState({ kind: 'ok', text: forwardTo.length ? `Sent to the orchestrator and forwarded to ${forwardTo.length} session(s).` : 'Sent to the orchestrator (not forwarded to any session).' });
    } catch (cause) {
      setState({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Section title="Message all agents">
      <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Textarea rows={2} value={text} aria-label="Message to the orchestrator" placeholder="Message the orchestrator…" onChange={(event) => setText(event.target.value)} className="resize-none" />
        <fieldset className="space-y-0.5">
          <legend className="text-[11.5px] text-muted">Also forward to (nothing is forwarded unless ticked)</legend>
          {!sessions.length && <p className="text-[11.5px] text-faint">No open sessions.</p>}
          {sessions.map((session) => (
            <label key={session.id} className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" className="accent-brand" checked={ticked.has(session.id)}
                onChange={(event) => setTicked((prev) => { const next = new Set(prev); if (event.target.checked) next.add(session.id); else next.delete(session.id); return next; })} />
              <span className="truncate">{session.title}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex items-center justify-between gap-2">
          {state ? <p role={state.kind === 'error' ? 'alert' : 'status'} className={cn('min-w-0 text-[11.5px]', state.kind === 'error' ? 'text-st-failed' : 'text-st-completed')}>{state.text}</p> : <span />}
          <Button type="submit" size="sm" variant="primary" disabled={sending || !text.trim()}>{sending ? 'Sending…' : 'Send'}</Button>
        </div>
      </form>
    </Section>
  );
}

function Approvals() {
  const approvals = useStudio((s) => s.snapshot?.approvals);
  const pending = (approvals ?? []).filter((approval) => approval.status === 'pending');
  return (
    <Section title="Approval requests" count={pending.length}>
      {!pending.length && <p className="text-[12px] text-muted">Nothing is waiting for approval.</p>}
      <ul className="space-y-2">
        {pending.map((approval) => (
          <li key={approval.id} className="space-y-1 text-[12.5px]">
            <p className="font-medium">{approval.title}</p>
            <p className="text-[11.5px] text-muted">{approval.kind} · {timeAgo(approval.createdAt)}</p>
            <div className="flex gap-1.5">
              <Button size="sm" variant="success" onClick={() => void useStudio.getState().decide(approval.id, 'approved')}>Approve</Button>
              <Button size="sm" variant="danger" onClick={() => void useStudio.getState().decide(approval.id, 'rejected')}>Reject</Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Blocked() {
  const tasks = useStudio((s) => s.snapshot?.tasks);
  const sessions = useSessions((s) => s.sessions);
  const events = useOrchestratorEvents(200);
  const problems = (tasks ?? []).filter((task) => task.status === 'blocked' || task.status === 'failed');
  const failedSessions = sessions.filter((session) => session.status === 'failed');
  const limits = events.filter((event) => event.type === 'provider.limit').slice(-5);
  const total = problems.length + failedSessions.length + limits.length;
  return (
    <Section title="Blocked tasks & errors" count={total}>
      {!total && <p className="text-[12px] text-muted">No blocked or failed work.</p>}
      <ul className="space-y-1.5">
        {problems.map((task) => (
          <li key={task.id} className="text-[12.5px]">
            <p className="flex items-center gap-2"><StatusBadge status={task.status} /><span className="truncate">{task.title}</span></p>
            {task.error && <p className="line-clamp-2 text-[11.5px] text-st-failed">{task.error}</p>}
          </li>
        ))}
        {failedSessions.map((session) => (
          <li key={session.id} className="text-[12.5px]">
            <p className="flex items-center gap-2"><StatusBadge status="failed" /><span className="truncate">Session: {session.title}</span></p>
            {session.lastError && <p className="line-clamp-2 text-[11.5px] text-st-failed">{session.lastError}</p>}
          </li>
        ))}
        {limits.map((event) => <li key={event.id} className="text-[12px] text-st-waiting">{event.message}</li>)}
      </ul>
    </Section>
  );
}

function ContextTab() {
  const project = useStudio((s) => s.snapshot?.project);
  const tasks = useStudio((s) => s.snapshot?.tasks);
  const sessions = useSessions((s) => s.sessions).filter((s) => s.status !== 'closed');
  if (!project) return <EmptyState title="No project loaded" />;
  return (
    <div>
      <Section title="Project">
        <dl className="space-y-1 text-[12.5px]">
          <div><dt className="text-[11px] text-faint">Name</dt><dd>{project.name}</dd></div>
          {project.description && <div><dt className="text-[11px] text-faint">Description</dt><dd className="whitespace-pre-wrap text-muted">{project.description}</dd></div>}
          <div><dt className="text-[11px] text-faint">Workspace</dt><dd className="break-all font-mono text-[11.5px]">{project.workspacePath}</dd></div>
          <div><dt className="text-[11px] text-faint">Integration branch</dt><dd className="font-mono text-[11.5px]">{project.integrationBranch ?? '—'}</dd></div>
          <div><dt className="text-[11px] text-faint">Test command</dt><dd className="font-mono text-[11.5px]">{project.testCommand || '—'}</dd></div>
        </dl>
      </Section>
      <Section title="Open sessions" count={sessions.length}>
        {!sessions.length && <p className="text-[12px] text-muted">No open sessions.</p>}
        <ul className="space-y-1.5">
          {sessions.map((session) => (
            <li key={session.id} className="text-[12.5px]">
              <p className="truncate">{session.title} <span className="text-faint">· {session.status}</span></p>
              <p className="truncate font-mono text-[11px] text-muted">
                {session.cwdKind === 'integration' ? 'integration' : session.branch ?? `session-${session.number}`}
                {session.taskId ? ` · ${tasks?.find((t) => t.id === session.taskId)?.title ?? 'linked task'}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ArtifactsTab() {
  const projectId = useStudio((s) => s.currentProjectId);
  const project = useStudio((s) => s.snapshot?.project);
  const tasks = useStudio((s) => s.snapshot?.tasks);
  const events = useStudio((s) => s.events);
  const artifacts = useMemo(() => deriveArtifacts(events, projectId), [events, projectId]);
  return (
    <div>
      <Section title="Merged files" count={artifacts.length}>
        {!artifacts.length && <p className="text-[12px] text-muted">No task has merged files into the integration branch yet.</p>}
        <ul className="space-y-1">
          {artifacts.slice(0, 80).map((artifact) => (
            <li key={artifact.path} className="text-[12px]">
              <p className="break-all font-mono text-[11.5px]">{artifact.path}</p>
              <p className="text-[11px] text-faint">{artifact.role ? roleName(artifact.role) : 'studio'}
                {artifact.taskId ? ` · ${tasks?.find((t) => t.id === artifact.taskId)?.title ?? 'task'}` : ''} · {timeAgo(artifact.at)}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Documents">
        <ul className="space-y-1 text-[12.5px]">
          <li>Implementation plan — {project?.planMarkdown ? 'available' : 'not generated yet'}</li>
          <li>Final report — {project?.reportMarkdown ? 'available' : 'not generated yet'}</li>
        </ul>
      </Section>
    </div>
  );
}

export function CoordinationDrawer({ tab, width, projectId }: { tab: DrawerTab; width: number; projectId: string }) {
  return (
    <aside aria-label="Coordination drawer" style={{ width }} className="flex h-full max-w-[85vw] shrink-0 flex-col border-l border-line-soft bg-surface">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-2">
        <div role="tablist" aria-label="Drawer sections" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              onClick={() => updateLayout((layout) => ({ ...layout, drawer: { ...layout.drawer, tab: item.id } }))}
              className={cn('-mb-px shrink-0 border-b-2 px-2 py-2 text-[12px]', tab === item.id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text')}>
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Close drawer" title="Close (Ctrl+.)" onClick={() => updateLayout((layout) => ({ ...layout, drawer: { ...layout.drawer, open: false } }))}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-ink-800 hover:text-text"><X size={14} aria-hidden="true" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'coordination' && (
          <>
            <CurrentWorkflow projectId={projectId} />
            <Handoffs />
            <Messages />
            <MessageAll />
            <Approvals />
            <Blocked />
          </>
        )}
        {tab === 'context' && <ContextTab />}
        {tab === 'artifacts' && <ArtifactsTab />}
      </div>
    </aside>
  );
}
