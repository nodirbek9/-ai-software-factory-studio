import type { OverviewAgentHealth } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { EmptyState, Panel, PanelHeader } from '@/components/ui/primitives';

const STATUS: Record<OverviewAgentHealth['status'], { label: string; className: string }> = {
  running: { label: 'Running', className: 'border-st-running/35 bg-st-running/10 text-st-running' },
  idle: { label: 'Idle', className: 'border-st-idle/35 bg-st-idle/10 text-st-idle' },
  failed: { label: 'Failed', className: 'border-st-failed/35 bg-st-failed/10 text-st-failed' },
  blocked: { label: 'Blocked', className: 'border-st-blocked/35 bg-st-blocked/10 text-st-blocked' },
  disconnected: { label: 'Disconnected', className: 'border-st-waiting/40 bg-st-waiting/10 text-st-waiting' },
};

function AgentRow({ agent, reason }: { agent: OverviewAgentHealth; reason: string | null }) {
  const Icon = ROLE_ICON[agent.role];
  const hue = ROLE_HUE[agent.role];
  const status = STATUS[agent.status];
  const disconnected = agent.status === 'disconnected';
  const name = AGENT_ROLE_INFO[agent.role].name;
  const provider = agent.providerLabel ?? agent.providerId;
  return (
    <li aria-label={`${name} agent`} className={cn('flex items-center gap-3 px-4 py-2.5', disconnected && 'bg-st-waiting/5')}>
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${hue} 16%, transparent)`, color: hue }}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{name}</span>
          <span className={cn('shrink-0 rounded-full border px-2 py-px text-[10.5px] font-medium', status.className)}>{status.label}</span>
        </div>
        <p className={cn('truncate text-[11.5px]', disconnected ? 'text-st-waiting' : 'text-muted')}>
          {provider} · <span className="font-mono">{agent.model}</span>
        </p>
        <p className="truncate text-[11.5px] text-faint" title={agent.currentTask?.title}>
          {disconnected && reason ? reason : agent.currentTask ? `${agent.currentTask.title} · ${agent.currentTask.projectName}` : 'No current task'}
        </p>
      </div>
      <span className="shrink-0 text-right text-[11.5px] tabular-nums text-muted" title={agent.successRate7d === null ? 'No task of this role finished in the last 7 days' : `${agent.finished7d} finished in 7 days`}>
        {agent.successRate7d === null ? '—' : `success 7 d: ${Math.round(agent.successRate7d * 100)} %`}
      </span>
    </li>
  );
}

export function AgentHealth({ agents }: { agents: OverviewAgentHealth[] }) {
  const setView = useStudio((s) => s.setView);
  const providers = useStudio((s) => s.providers);
  /** Why the assigned provider is unusable, taken from the provider list the studio already holds. */
  const disconnectedReason = (agent: OverviewAgentHealth): string => {
    const found = providers.find((p) => p.id === agent.providerId);
    if (!found) return `${agent.providerLabel ?? agent.providerId} is not available`;
    if (!found.enabled) return `${found.label} is disabled`;
    return found.reason ?? `${found.label} is not available`;
  };
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Agent Health">
        <button type="button" onClick={() => setView('agents')} className="rounded text-[12px] text-brand hover:underline">View all →</button>
      </PanelHeader>
      {agents.length ? (
        <ul className="divide-y divide-line-soft">
          {agents.map((agent) => <AgentRow key={agent.role} agent={agent} reason={agent.status === 'disconnected' ? disconnectedReason(agent) : null} />)}
        </ul>
      ) : (
        <EmptyState title="No agent data">The server returned no agent roles.</EmptyState>
      )}
    </Panel>
  );
}
