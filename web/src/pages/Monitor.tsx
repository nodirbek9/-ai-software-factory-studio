import { useEffect, useState } from 'react';
import type { LiveAgent, LiveFinished, LiveProvider, LiveQueued } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { Activity, ArrowRightLeft, CheckCircle2, Clock, Hourglass, Radio, XCircle } from 'lucide-react';
import { cn, formatTokens, statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { EmptyState, Panel, PanelHeader } from '@/components/ui/primitives';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';

/** Re-renders every second so elapsed timers tick without refetching. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function elapsed(fromIso: string | null, now: number): string {
  if (!fromIso) return '—';
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const EFFORT_TONE: Record<string, string> = {
  low: 'text-muted border-line', medium: 'text-brand-2 border-brand-2/40',
  high: 'text-st-planning border-st-planning/40', xhigh: 'text-st-waiting border-st-waiting/40', max: 'text-st-failed border-st-failed/40',
};

function Chip({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('inline-flex items-center gap-1 rounded-md border border-line bg-ink-950/60 px-2 py-0.5 text-[11.5px]', className)}>{children}</span>;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Panel className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={cn('text-[26px] font-semibold leading-tight tabular-nums', tone)}>{value}</span>
      {sub && <span className="truncate text-[11.5px] text-faint">{sub}</span>}
    </Panel>
  );
}

function WorkingCard({ agent, now, onOpen }: { agent: LiveAgent; now: number; onOpen: () => void }) {
  const Icon = ROLE_ICON[agent.role];
  const hue = ROLE_HUE[agent.role];
  const quietFor = agent.lastOutputAt ? Math.floor((now - Date.parse(agent.lastOutputAt)) / 1000) : null;
  return (
    <button onClick={onOpen} className="group relative w-full overflow-hidden rounded-xl border border-st-running/30 bg-ink-900/90 p-4 pl-5 text-left transition-colors hover:border-st-running/60">
      <span className="absolute inset-y-0 left-0 w-[3px] animate-rail bg-st-running" aria-hidden />
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${hue} 16%, transparent)`, color: hue }}>
          <Icon size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[15px] font-semibold">{AGENT_ROLE_INFO[agent.role].name}</span>
            <span className="truncate text-[12px] text-muted">in {agent.projectName}</span>
          </div>
          <p className="mt-0.5 truncate text-[13px] text-text/90" title={agent.taskTitle}>{agent.taskTitle}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="flex items-center justify-end gap-1.5 text-[18px] font-semibold tabular-nums text-st-running">
            <Clock size={15} />{elapsed(agent.startedAt, now)}
          </div>
          <div className="text-[11px] text-faint">attempt {agent.attempt} of {agent.maxAttempts}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip title="Provider that is running this agent">{agent.providerLabel ?? 'unknown provider'}{!agent.isAi && ' (not AI)'}</Chip>
        <Chip className="font-mono" title="Model reported for this run">{agent.model ?? 'default model'}</Chip>
        <Chip className={cn(EFFORT_TONE[agent.effort ?? ''] ?? 'text-faint')} title="Reasoning effort">
          {agent.effort ? `${agent.effort} effort` : 'default effort'}
        </Chip>
        {agent.fallbackFrom && (
          <Chip className="border-st-waiting/40 text-st-waiting" title="The assigned provider was not usable">
            <ArrowRightLeft size={11} /> fallback from {agent.fallbackFrom}
          </Chip>
        )}
        <Chip className="text-faint" title="Last verified step">step: {agent.checkpoint === 'none' ? 'starting' : agent.checkpoint.replace('_', ' ')}</Chip>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-lg bg-ink-950/70 px-3 py-2 font-mono text-[12px]">
        <Activity size={13} className="shrink-0 text-st-running" />
        <span className="min-w-0 flex-1 truncate text-text/85">{agent.lastOutput ?? 'Waiting for the first output from the model…'}</span>
        {quietFor !== null && <span className="shrink-0 text-faint">{quietFor < 5 ? 'now' : `${quietFor}s ago`}</span>}
      </div>
    </button>
  );
}

function QueueList({ items }: { items: LiveQueued[] }) {
  if (!items.length) return <p className="px-4 py-3 text-[12.5px] text-muted">Nothing is waiting to start.</p>;
  return (
    <ul className="divide-y divide-line-soft">
      {items.map((q) => (
        <li key={q.taskId} className="flex items-center gap-2.5 px-4 py-2 text-[12.5px]">
          {q.status === 'waiting_approval' ? <Hourglass size={14} className="shrink-0 text-st-waiting" /> : <Radio size={14} className="shrink-0 text-brand-2" />}
          <span className="shrink-0" style={{ color: ROLE_HUE[q.role] }}>{AGENT_ROLE_INFO[q.role].name}</span>
          <span className="min-w-0 flex-1 truncate">{q.taskTitle}</span>
          <span className={cn('shrink-0 text-[11px]', statusMeta(q.status).text)}>{q.status === 'waiting_approval' ? 'needs your approval' : 'next in line'}</span>
        </li>
      ))}
    </ul>
  );
}

function ProviderRow({ p }: { p: LiveProvider }) {
  const state = !p.enabled ? 'off' : p.limitedUntil ? 'limited' : !p.available ? 'unavailable' : p.running ? 'working' : 'ready';
  const dot = { off: 'bg-st-idle', limited: 'bg-st-failed', unavailable: 'bg-st-waiting', working: 'bg-st-running animate-rail', ready: 'bg-st-completed' }[state];
  const resetAt = p.limitedUntil ? new Date(p.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <li className={cn('grid grid-cols-[1fr_auto] items-center gap-x-3 px-4 py-2', !p.enabled && 'opacity-55')}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
        <span className="truncate text-[12.5px]">{p.label}</span>
        {p.running > 0 && <span className="rounded-full bg-st-running/15 px-1.5 text-[11px] font-medium text-st-running">{p.running} working</span>}
        {resetAt && <span className="rounded-full bg-st-failed/15 px-1.5 text-[11px] font-medium text-st-failed" title="Usage limit used up; routing skips it">limit until {resetAt}</span>}
      </div>
      <span className="text-right text-[11.5px] tabular-nums text-muted">
        {p.callsToday ? `${p.callsToday} calls, ${formatTokens(p.tokensToday)} tok${p.costToday ? `, $${p.costToday.toFixed(2)}` : ''}` : state === 'off' ? 'off' : 'no calls today'}
      </span>
    </li>
  );
}

function RecentTable({ items, onOpen }: { items: LiveFinished[]; onOpen: (r: LiveFinished) => void }) {
  if (!items.length) return <p className="px-4 py-3 text-[12.5px] text-muted">No finished tasks yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[12.5px]">
        <thead className="text-[11px] text-faint">
          <tr className="border-b border-line-soft">
            <th className="px-4 py-2 font-medium">Result</th><th className="px-2 py-2 font-medium">Agent</th><th className="px-2 py-2 font-medium">Task</th>
            <th className="px-2 py-2 font-medium">Model and effort</th><th className="px-2 py-2 font-medium">Took</th><th className="px-4 py-2 text-right font-medium">Finished</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.taskId} onClick={() => onOpen(r)} className="cursor-pointer border-b border-line-soft/60 hover:bg-ink-850">
              <td className="px-4 py-2">
                {r.status === 'completed' ? <span className="inline-flex items-center gap-1 text-st-completed"><CheckCircle2 size={13} /> done</span>
                  : <span className={cn('inline-flex items-center gap-1', statusMeta(r.status).text)} title={r.error ?? undefined}><XCircle size={13} /> {statusMeta(r.status).label.toLowerCase()}</span>}
              </td>
              <td className="px-2 py-2" style={{ color: ROLE_HUE[r.role] }}>{AGENT_ROLE_INFO[r.role].name}</td>
              <td className="max-w-[280px] px-2 py-2"><div className="truncate" title={r.taskTitle}>{r.taskTitle}</div><div className="truncate text-[11px] text-faint">{r.projectName}</div></td>
              <td className="px-2 py-2 font-mono text-[11.5px] text-muted">{r.model ?? '—'}{r.effort ? <span className="text-st-planning"> {r.effort}</span> : null}</td>
              <td className="px-2 py-2 tabular-nums text-muted">{duration(r.durationMs)}</td>
              <td className="px-4 py-2 text-right text-muted">{timeAgo(r.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Monitor() {
  const { live, connection, selectProject, selectTask, selectAgent, setView } = useStudio();
  const now = useNow();

  const open = async (projectId: string, taskId: string, role: LiveAgent['role']) => {
    await selectProject(projectId);
    selectTask(taskId);
    selectAgent(role);
    setView('workflows');
  };

  if (!live) return <div className="grid h-full place-items-center text-muted">Loading live state…</div>;

  const working = live.running.length;
  const waitingYou = live.queued.filter((q) => q.status === 'waiting_approval').length;
  const queued = live.queued.length - waitingYou;
  const todayTokens = live.providers.reduce((s, p) => s + p.tokensToday, 0);
  const todayCost = live.providers.reduce((s, p) => s + p.costToday, 0);
  const todayCalls = live.providers.reduce((s, p) => s + p.callsToday, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Live monitor</h1>
          <p className="text-[12.5px] text-muted">Every agent working right now, in all projects, with the provider, model and effort it really runs on.</p>
        </div>
        <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px]',
          connection === 'live' ? 'border-st-completed/30 text-st-completed' : 'border-st-waiting/30 text-st-waiting')}>
          <span className={cn('h-2 w-2 rounded-full', connection === 'live' ? 'bg-st-completed animate-rail' : 'bg-st-waiting')} />
          {connection === 'live' ? `Live, updated ${timeAgo(live.generatedAt)}` : 'Reconnecting…'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Agents working" value={`${working} of ${live.maxParallel}`} sub="parallel slots in use" tone={working ? 'text-st-running' : 'text-muted'} />
        <Stat label="Next in line" value={String(queued)} sub="ready tasks waiting for a free slot" tone={queued ? 'text-brand-2' : 'text-muted'} />
        <Stat label="Waiting for you" value={String(waitingYou)} sub={waitingYou ? 'open the project to approve' : 'no approvals pending'} tone={waitingYou ? 'text-st-waiting' : 'text-muted'} />
        <Stat label="Today" value={formatTokens(todayTokens)} sub={`${todayCalls} model calls${todayCost ? `, $${todayCost.toFixed(2)} Claude cost` : ''}`} />
      </div>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold text-muted">Working now</h2>
        {working ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {live.running.map((agent) => <WorkingCard key={agent.taskId} agent={agent} now={now} onOpen={() => void open(agent.projectId, agent.taskId, agent.role)} />)}
          </div>
        ) : (
          <Panel><EmptyState title="No agent is working right now">
            {waitingYou ? 'A plan is waiting for your approval — open its project.' : 'Start or resume a project and its agents appear here the moment they begin.'}
          </EmptyState></Panel>
        )}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel className="overflow-hidden">
          <PanelHeader title={`Queue (${live.queued.length})`} />
          <QueueList items={live.queued} />
        </Panel>
        <Panel className="overflow-hidden">
          <PanelHeader title="Providers today" />
          <ul className="divide-y divide-line-soft">{live.providers.map((p) => <ProviderRow key={p.id} p={p} />)}</ul>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <PanelHeader title="Recently finished" />
        <RecentTable items={live.recent} onOpen={(r) => void open(r.projectId, r.taskId, r.role)} />
      </Panel>
    </div>
  );
}
