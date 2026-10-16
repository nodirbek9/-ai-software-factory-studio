import type { ReactNode } from 'react';
import type { OverviewResponse, SystemHealth, UsageSummary } from '@asf/shared';
import { AlertCircle, Bot, Coins, FolderGit2, Hourglass, ListChecks, type LucideIcon } from 'lucide-react';
import { cn, formatTokens } from '@/lib/utils';
import { useStudio, type View } from '@/store/studio';
import { Panel, Skeleton } from '@/components/ui/primitives';
import type { V2Result } from './useV2';
import { tokenDelta } from './format';

interface KpiProps {
  icon: LucideIcon;
  /** CSS color of the icon tile. */
  tint: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
  linkLabel: string;
  view: View;
}

function KpiCard({ icon: Icon, tint, label, value, sub, badge, linkLabel, view }: KpiProps) {
  const setView = useStudio((s) => s.setView);
  return (
    <Panel className="flex min-w-0 flex-col gap-2 p-4" role="group" aria-label={label}>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint }}>
          <Icon size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-muted">{label}</span>
            {badge}
          </div>
          <div className="text-[26px] font-semibold leading-tight tabular-nums">{value}</div>
        </div>
      </div>
      <div className="min-h-[16px] text-[11.5px] text-muted">{sub}</div>
      <button type="button" onClick={() => setView(view)} className="self-start rounded text-[12px] text-brand hover:underline">{linkLabel} →</button>
    </Panel>
  );
}

const PILL: Record<SystemHealth['overall'], { label: string; className: string }> = {
  ok: { label: 'Healthy', className: 'border-st-completed/35 bg-st-completed/10 text-st-completed' },
  degraded: { label: 'Degraded', className: 'border-st-waiting/35 bg-st-waiting/10 text-st-waiting' },
  down: { label: 'Down', className: 'border-st-failed/35 bg-st-failed/10 text-st-failed' },
};

const DELTA_TONE = { up: 'text-st-completed', down: 'text-st-waiting', flat: 'text-muted', none: 'text-muted' } as const;

export function KpiRow({ overview, usage, health }: { overview: OverviewResponse; usage: V2Result<UsageSummary>; health: V2Result<SystemHealth> }) {
  const { projects, agents, tasks, approvals } = overview;
  const pill = health.data ? PILL[health.data.overall] : null;
  const delta = usage.data ? tokenDelta(usage.data.totalTokens, usage.data.previousTotalTokens) : null;
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 min-[1366px]:grid-cols-3 min-[1600px]:grid-cols-6">
      <KpiCard icon={FolderGit2} tint="var(--color-brand)" label="Active projects" value={projects.active}
        sub={`+${projects.createdLast7d} in 7 days · ${projects.total} total`} linkLabel="View projects" view="projects" />
      <KpiCard icon={Bot} tint="var(--color-st-running)" label="Running agents" value={`${agents.running} / ${agents.slots}`}
        badge={pill && <span className={cn('rounded-full border px-2 py-0.5 text-[10.5px] font-medium', pill.className)}>{pill.label}</span>}
        sub="running / parallel slots" linkLabel="View runs" view="monitor" />
      <KpiCard icon={Hourglass} tint="var(--color-brand-2)" label="Queued tasks" value={agents.queued}
        sub="ready, waiting for a free slot" linkLabel="View queue" view="monitor" />
      <KpiCard icon={ListChecks} tint="var(--color-st-planning)" label="Open tasks" value={tasks.open}
        sub={`${tasks.completedLast24h} completed in 24 h`} linkLabel="View tasks" view="workflows" />
      <KpiCard icon={AlertCircle} tint={tasks.failedLast24h ? 'var(--color-st-failed)' : 'var(--color-st-idle)'} label="Failed (24 h)" value={tasks.failedLast24h}
        sub={`${approvals.pending} pending approval${approvals.pending === 1 ? '' : 's'}`} linkLabel="View tasks" view="workflows" />
      <KpiCard icon={Coins} tint="var(--color-agent-claude)" label="Tokens (24 h)"
        value={usage.data ? formatTokens(usage.data.totalTokens) : usage.loading ? <Skeleton className="mt-1 h-6 w-16" /> : '—'}
        sub={delta ? <span className={DELTA_TONE[delta.direction]}>{delta.text}</span> : usage.loading ? undefined : 'Usage unavailable'}
        linkLabel="View models" view="models" />
    </section>
  );
}
