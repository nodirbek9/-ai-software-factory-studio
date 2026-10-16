import type { SystemHealth, UsageSummary } from '@asf/shared';
import { useV2 } from '@/features/home/useV2';
import { formatTokens } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { useSessions } from './sessionsStore';

function Item({ label, children, title }: { label: string; children: string; title?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={title}>
      <span className="text-faint">{label}</span>
      <span className="tabular-nums text-text">{children}</span>
    </span>
  );
}

/** Bottom bar of the workspace: only measured values; a value that is not available shows “—”. */
export function StatusBar() {
  const project = useStudio((s) => s.snapshot?.project);
  const sessions = useSessions((s) => s.sessions);
  const budget = useSessions((s) => s.budget);
  const usage = useV2<UsageSummary>('/api/v2/usage/summary?range=24h');
  const health = useV2<SystemHealth>('/api/v2/system/health');

  const running = sessions.filter((session) => session.status === 'running').length;
  const queued = sessions.filter((session) => session.status === 'queued').length;
  const system = health.data?.system;
  const ram = system && system.totalMemBytes > 0 ? Math.round(((system.totalMemBytes - system.freeMemBytes) / system.totalMemBytes) * 100) : null;

  return (
    <div role="group" aria-label="Workspace status" className="flex h-7 shrink-0 items-center gap-4 overflow-x-auto border-t border-line-soft bg-sidebar px-3 text-[11.5px]">
      <Item label="Project">{project?.name ?? '—'}</Item>
      <Item label="Sessions" title="Sessions of this project that are running or waiting for a slot">{`${running} running · ${queued} queued`}</Item>
      <Item label="Slots" title="Agent processes in use across all projects / the configured limit">
        {budget ? `${budget.running.length} / ${budget.limit} · ${budget.queued.length} queued` : '—'}
      </Item>
      <Item label="Tokens (24 h)">{usage.data ? formatTokens(usage.data.totalTokens) : '—'}</Item>
      <Item label="CPU">{system?.cpuPercent != null ? `${Math.round(system.cpuPercent)}%` : '—'}</Item>
      <Item label="RAM">{ram !== null ? `${ram}%` : '—'}</Item>
    </div>
  );
}
