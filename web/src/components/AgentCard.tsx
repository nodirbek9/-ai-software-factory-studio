import type { AgentView, ProviderInfo, Task } from '@asf/shared';
import { AlertTriangle, MessageSquare } from 'lucide-react';
import { cn, formatTokens, statusMeta, timeAgo } from '@/lib/utils';
import { Button, Progress, StatusBadge } from '@/components/ui/primitives';
import { ROLE_HUE, ROLE_ICON } from './agentMeta';

interface Props {
  agent: AgentView;
  provider: ProviderInfo | undefined;
  /** The agent's most recently started task — tells which provider actually ran (fallback may differ from the assignment). */
  lastTask: Task | undefined;
  providers: ProviderInfo[];
  selected: boolean;
  onSelect: () => void;
  onChat: () => void;
}

function providerWarning(provider: ProviderInfo | undefined): string | null {
  if (!provider) return 'Unknown provider';
  if (!provider.enabled) return `${provider.label} is disabled — fallback routing applies`;
  if (!provider.available) return `${provider.label} unavailable: ${provider.reason ?? 'not detected'}`;
  return null;
}

export function AgentCard({ agent, provider, lastTask, providers, selected, onSelect, onChat }: Props) {
  const Icon = ROLE_ICON[agent.role];
  const meta = statusMeta(agent.status);
  const warning = providerWarning(provider);
  const ranOn = lastTask?.providerId && lastTask.providerId !== agent.providerId
    ? providers.find((p) => p.id === lastTask.providerId) : undefined;
  const tokens = agent.usage.inputTokens + agent.usage.outputTokens;

  return (
    <article onClick={onSelect}
      className={cn('group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-ink-900/85 pl-4 pr-3.5 pb-3 pt-3 transition-colors',
        selected ? 'border-brand/60 bg-ink-850' : 'border-line-soft hover:border-line')}>
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', meta.live && 'animate-rail')} style={{ background: meta.color }} aria-hidden />

      <header className="flex items-start gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${ROLE_HUE[agent.role]} 16%, transparent)`, color: ROLE_HUE[agent.role] }}>
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold leading-tight">{agent.name}</h3>
          <p className="truncate text-[12px] text-muted">{agent.title}</p>
        </div>
        <StatusBadge status={agent.status} />
      </header>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-faint">Model</dt>
        <dd className="min-w-0 text-text">
          <div className="flex items-center gap-1 truncate">
            <span className="truncate">{provider?.label ?? agent.providerId}{agent.model ? ` / ${agent.model}` : ''}{agent.effort ? ` (${agent.effort} effort)` : ''}</span>
            {warning && <span title={warning} className="text-st-waiting"><AlertTriangle size={12} /></span>}
          </div>
          {lastTask?.providerId === agent.providerId && lastTask.model && lastTask.model !== agent.model && (
            <div className="truncate text-muted">Ran as {lastTask.model}</div>
          )}
        </dd>
        {ranOn && (
          <>
            <dt className="text-faint">Ran on</dt>
            <dd className="truncate text-st-waiting" title="The assigned provider was not usable, so the routing policy fell back">
              {ranOn.label}{lastTask?.model ? ` / ${lastTask.model}` : ''} (fallback)
            </dd>
          </>
        )}
        <dt className="text-faint">Task</dt>
        <dd className="truncate text-text" title={agent.currentTask?.title}>{agent.currentTask ? agent.currentTask.title : <span className="text-faint">No active task</span>}</dd>
        <dt className="text-faint">Activity</dt>
        <dd className="truncate text-muted" title={agent.lastActivity?.message}>
          {agent.lastActivity ? `${timeAgo(agent.lastActivity.at)} — ${agent.lastActivity.message}` : '—'}
        </dd>
      </dl>

      <div className="mt-3 space-y-1">
        <div className="flex justify-between text-[11px] text-muted">
          <span>{agent.tasksCompleted} of {agent.tasksTotal} tasks verified</span>
          <span className="tabular-nums">{tokens ? `${formatTokens(tokens)} tokens` : 'no usage'}{agent.usage.costUsd ? `, $${agent.usage.costUsd.toFixed(3)}` : ''}</span>
        </div>
        <Progress value={agent.progress} color={meta.color} />
      </div>

      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onChat(); }}><MessageSquare size={13} /> Open chat</Button>
      </div>
    </article>
  );
}
