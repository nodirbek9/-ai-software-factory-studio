import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { AgentRole, Approval, Task } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { CheckCircle2, FileCode2, PanelRightClose, PanelRightOpen, RotateCcw, Send, XCircle } from 'lucide-react';
import { cn, formatDuration, statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { Button, EmptyState, StatusBadge, Textarea } from '@/components/ui/primitives';
import { Markdown } from '@/components/Markdown';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';

const TAB = 'px-2.5 py-2 text-[12px] text-muted data-[state=active]:text-text data-[state=active]:shadow-[inset_0_-2px_0_var(--color-brand)]';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[12px] font-semibold text-muted">{title}</h3>
      {children}
    </section>
  );
}

function TaskDetails({ task }: { task: Task }) {
  const { retryTask, cancelTask } = useStudio();
  const canRetry = task.status === 'failed' || task.status === 'cancelled';
  const canCancel = ['pending', 'ready', 'running', 'blocked', 'waiting_approval'].includes(task.status);
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-semibold leading-snug">{task.title}</h3>
          <StatusBadge status={task.status} />
        </div>
        <p className="mt-1 text-[12px] text-muted">{AGENT_ROLE_INFO[task.role].name} — {task.kind} — key <code className="text-text">{task.key}</code></p>
      </div>
      {task.description && <p className="text-[13px] leading-relaxed text-text/90">{task.description}</p>}
      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        {[
          ['Attempts', `${task.attempt}/${task.maxAttempts}`],
          ['Duration', formatDuration(task.startedAt, task.finishedAt)],
          ['Provider', task.providerId ? `${task.providerId}${task.model ? ` / ${task.model}` : ''}` : '—'],
          ['Checkpoint', task.checkpoint],
          ['Depends on', task.dependsOn.join(', ') || '—'],
          ['Tokens', task.usage ? `${task.usage.inputTokens + task.usage.outputTokens}` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-ink-850 px-2.5 py-1.5"><dt className="text-[11px] text-faint">{k}</dt><dd className="truncate" title={v}>{v}</dd></div>
        ))}
      </dl>
      {(canRetry || canCancel) && (
        <div className="flex gap-2">
          {canRetry && <Button size="sm" onClick={() => void retryTask(task.id)}><RotateCcw size={13} /> Retry task</Button>}
          {canCancel && <Button size="sm" variant="danger" onClick={() => void cancelTask(task.id)}><XCircle size={13} /> Cancel task</Button>}
        </div>
      )}
      {task.error && (
        <Section title="Error">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-st-failed/30 bg-st-failed/10 p-2.5 font-mono text-[11.5px] text-st-failed">{task.error}</pre>
        </Section>
      )}
      {task.testResult && (
        <Section title="Test results">
          <div className={cn('rounded-lg border p-2.5 text-[12px]', task.testResult.passed ? 'border-st-completed/30 bg-st-completed/10' : 'border-st-failed/30 bg-st-failed/10')}>
            <div className="flex items-center gap-1.5 font-medium">
              {task.testResult.passed ? <CheckCircle2 size={14} className="text-st-completed" /> : <XCircle size={14} className="text-st-failed" />}
              <code>{task.testResult.command}</code> — {task.testResult.summary} (exit {task.testResult.exitCode}, {(task.testResult.durationMs / 1000).toFixed(1)}s)
            </div>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{task.testResult.outputTail}</pre>
          </div>
        </Section>
      )}
      {task.filesChanged.length > 0 && (
        <Section title={`Files changed (${task.filesChanged.length})`}>
          <ul className="space-y-0.5">
            {task.filesChanged.map((f) => <li key={f} className="flex items-center gap-1.5 font-mono text-[11.5px] text-text/90"><FileCode2 size={12} className="text-faint" />{f}</li>)}
          </ul>
        </Section>
      )}
      {task.resultSummary && (
        <Section title="Result">
          <Markdown className="rounded-lg bg-ink-850 p-2.5">{task.resultSummary}</Markdown>
        </Section>
      )}
    </div>
  );
}

function AgentChat({ role }: { role: AgentRole }) {
  const { messages, sendMessage } = useStudio();
  const [draft, setDraft] = useState('');
  const list = messages[role] ?? [];
  const end = useRef<HTMLDivElement>(null);
  const waiting = list.at(-1)?.direction === 'user';
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [list.length]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void sendMessage(role, text);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto pb-2">
        {!list.length && <EmptyState title="No conversation yet">Ask about the plan, a failure or a decision. Chat is read-only: agents cannot run commands or edit files from here.</EmptyState>}
        {list.map((m) => (
          <div key={m.id} className={cn('max-w-[92%] rounded-lg px-2.5 py-2 text-[12.5px]',
            m.direction === 'user' ? 'ml-auto bg-brand/15 text-text' : m.direction === 'system' ? 'bg-st-waiting/10 text-st-waiting' : 'bg-ink-850')}>
            {m.direction === 'agent' ? <Markdown>{m.content}</Markdown> : <p className="whitespace-pre-wrap">{m.content}</p>}
            <div className="mt-1 text-[10.5px] text-faint">{timeAgo(m.createdAt)}</div>
          </div>
        ))}
        {waiting && <p className="text-[12px] text-muted animate-rail">{AGENT_ROLE_INFO[role].name} is answering…</p>}
        <div ref={end} />
      </div>
      <div className="flex gap-2 border-t border-line-soft pt-2">
        <Textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${AGENT_ROLE_INFO[role].name}`}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <Button variant="primary" size="icon" onClick={submit} aria-label="Send message" disabled={!draft.trim()}><Send size={15} /></Button>
      </div>
    </div>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const { decide, snapshot } = useStudio();
  const [note, setNote] = useState('');
  const [showPlan, setShowPlan] = useState(false);
  const tasks = (approval.details.tasks as { key: string; title: string; role: AgentRole; dependsOn: string[] }[] | undefined) ?? [];
  return (
    <div className="space-y-2.5 rounded-xl border border-st-waiting/40 bg-st-waiting/5 p-3">
      <h3 className="text-[13px] font-semibold">{approval.title}</h3>
      {approval.kind === 'command' && <p className="text-[12px] text-muted">Command <code className="text-text">{String(approval.details.command)}</code> is not in the allowlist.</p>}
      {tasks.length > 0 && (
        <ol className="space-y-1 text-[12px]">
          {tasks.map((t, i) => (
            <li key={t.key} className="flex gap-2">
              <span className="w-4 shrink-0 text-right tabular-nums text-faint">{i + 1}</span>
              <span className="shrink-0" style={{ color: ROLE_HUE[t.role] }}>{AGENT_ROLE_INFO[t.role].name}</span>
              <span className="text-text">{t.title}</span>
            </li>
          ))}
        </ol>
      )}
      {approval.kind === 'plan' && snapshot?.project.planMarkdown && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setShowPlan((v) => !v)}>{showPlan ? 'Hide technical plan' : 'Read technical plan'}</Button>
          {showPlan && <Markdown className="max-h-80 overflow-y-auto rounded-lg bg-ink-950 p-3">{snapshot.project.planMarkdown}</Markdown>}
        </>
      )}
      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
      <div className="flex gap-2">
        <Button size="sm" variant="success" onClick={() => void decide(approval.id, 'approved', note)}><CheckCircle2 size={13} /> Approve</Button>
        <Button size="sm" variant="danger" onClick={() => void decide(approval.id, 'rejected', note)}><XCircle size={13} /> Reject</Button>
      </div>
    </div>
  );
}

function TaskLog({ taskId, role }: { taskId: string | null; role: AgentRole | null }) {
  const { events } = useStudio();
  const items = useMemo(() => events.filter((e) => (taskId ? e.taskId === taskId : role ? e.role === role : true)).slice(-300), [events, taskId, role]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [items.length]);
  if (!items.length) return <EmptyState title="No log lines yet" />;
  return (
    <div className="space-y-1 font-mono text-[11px]">
      {items.map((e) => (
        <div key={e.id} className={cn('whitespace-pre-wrap break-words', e.level === 'error' ? 'text-st-failed' : e.level === 'warn' ? 'text-st-waiting' : e.type === 'agent.output' ? 'text-faint' : 'text-text/85')}>
          <span className="text-faint">{new Date(e.createdAt).toLocaleTimeString()} </span>{e.message}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function RightPanel() {
  const { snapshot, selectedRole, selectedTaskId, rightCollapsed, toggleRight } = useStudio();
  const [tab, setTab] = useState('details');
  const pending = snapshot?.approvals.filter((a) => a.status === 'pending') ?? [];
  useEffect(() => { if (pending.length) setTab('approvals'); }, [pending.length]);
  useEffect(() => { if (selectedTaskId) setTab('details'); }, [selectedTaskId]);

  if (rightCollapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center border-l border-line-soft bg-ink-900/60 py-3">
        <Button variant="ghost" size="icon" onClick={toggleRight} aria-label="Open details panel"><PanelRightOpen size={16} /></Button>
        {pending.length > 0 && <span className="mt-2 rounded-full bg-st-waiting px-1.5 text-[10px] font-semibold text-ink-950">{pending.length}</span>}
      </aside>
    );
  }

  const task = snapshot?.tasks.find((t) => t.id === selectedTaskId) ?? null;
  const agent = snapshot?.agents.find((a) => a.role === selectedRole) ?? null;
  const agentTasks = snapshot?.tasks.filter((t) => t.role === selectedRole) ?? [];
  const Icon = agent ? ROLE_ICON[agent.role] : null;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line-soft bg-ink-900/60 xl:w-[380px]">
      <div className="flex h-12 items-center gap-2 border-b border-line-soft px-3">
        {agent && Icon ? (
          <>
            <Icon size={16} style={{ color: ROLE_HUE[agent.role] }} />
            <span className="text-[13px] font-semibold">{agent.name}</span>
            <StatusBadge status={agent.status} className="ml-1" />
          </>
        ) : <span className="text-[13px] font-semibold">Details</span>}
        <Button variant="ghost" size="icon" className="ml-auto" onClick={toggleRight} aria-label="Collapse details panel"><PanelRightClose size={16} /></Button>
      </div>
      <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="flex border-b border-line-soft px-1.5">
          <Tabs.Trigger value="details" className={TAB}>Details</Tabs.Trigger>
          <Tabs.Trigger value="chat" className={TAB} disabled={!selectedRole}>Chat</Tabs.Trigger>
          <Tabs.Trigger value="logs" className={TAB}>Logs</Tabs.Trigger>
          <Tabs.Trigger value="approvals" className={TAB}>Approvals{pending.length ? ` (${pending.length})` : ''}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="details" className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {task ? <TaskDetails task={task} /> : agent ? (
            <div className="space-y-3">
              <p className="text-[13px] text-muted">{AGENT_ROLE_INFO[agent.role].description}</p>
              <Section title={`Tasks (${agentTasks.length})`}>
                {!agentTasks.length && <p className="text-[12px] text-faint">No tasks assigned in this project.</p>}
                {agentTasks.map((t) => (
                  <button key={t.id} onClick={() => useStudio.getState().selectTask(t.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-ink-850">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', statusMeta(t.status).bg)} />
                    <span className="truncate">{t.title}</span>
                    <span className={cn('ml-auto text-[11px]', statusMeta(t.status).text)}>{statusMeta(t.status).label}</span>
                  </button>
                ))}
              </Section>
            </div>
          ) : (
            <EmptyState title="Select an agent or a task">Click an agent card or a node in the workflow graph to see its details, logs, files and test results.</EmptyState>
          )}
        </Tabs.Content>
        <Tabs.Content value="chat" className="min-h-0 flex-1 p-3.5">{selectedRole ? <AgentChat role={selectedRole} /> : null}</Tabs.Content>
        <Tabs.Content value="logs" className="min-h-0 flex-1 overflow-y-auto p-3.5"><TaskLog taskId={selectedTaskId} role={selectedRole} /></Tabs.Content>
        <Tabs.Content value="approvals" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
          {!pending.length && <EmptyState title="No pending approvals">Plans and non-allowlisted commands wait here for your decision.</EmptyState>}
          {snapshot?.approvals.filter((a) => a.status !== 'pending').map((a) => (
            <div key={a.id} className="rounded-lg bg-ink-850 px-2.5 py-2 text-[12px]">
              <span className={a.status === 'approved' ? 'text-st-completed' : 'text-st-failed'}>{a.status === 'approved' ? 'Approved' : 'Rejected'}</span>
              <span className="text-muted"> {a.title}</span>
              {a.note && <p className="text-faint">“{a.note}”</p>}
            </div>
          ))}
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
