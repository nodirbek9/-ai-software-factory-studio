import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { isActive, NAV_ITEMS, type NavItem } from '@/app/navigation';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

type Health = 'ok' | 'degraded' | 'down';
const HEALTH_DOT: Record<Health, string> = { ok: 'bg-st-completed', degraded: 'bg-st-waiting', down: 'bg-st-failed' };

/** Real status rows only: the live connection, provider availability and running agents (no constant percentages). */
function SystemStatus({ collapsed }: { collapsed: boolean }) {
  const connection = useStudio((s) => s.connection);
  const providers = useStudio((s) => s.providers);
  const working = useStudio((s) => s.live?.running.length ?? 0);
  const enabled = providers.filter((p) => p.enabled && p.isAi);
  const usable = enabled.filter((p) => p.available && !p.limitedUntil);
  const rows: { label: string; value: string; health: Health }[] = [
    { label: 'Studio server', value: connection === 'live' ? 'Connected' : connection === 'connecting' ? 'Connecting…' : 'Offline',
      health: connection === 'live' ? 'ok' : connection === 'connecting' ? 'degraded' : 'down' },
    { label: 'AI providers', value: `${usable.length} of ${enabled.length} usable`,
      health: !enabled.length || !usable.length ? 'down' : usable.length < enabled.length ? 'degraded' : 'ok' },
    { label: 'Agents working', value: String(working), health: 'ok' },
  ];
  const overall: Health = rows.some((r) => r.health === 'down') ? 'down' : rows.some((r) => r.health === 'degraded') ? 'degraded' : 'ok';
  if (collapsed) {
    return <span className={cn('mx-auto block h-2.5 w-2.5 rounded-full', HEALTH_DOT[overall])} title={rows.map((r) => `${r.label}: ${r.value}`).join('\n')} />;
  }
  return (
    <section aria-label="System status" className="rounded-lg border border-line-soft bg-surface/60 p-2.5">
      <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium">
        <span className={cn('h-2 w-2 rounded-full', HEALTH_DOT[overall])} />
        {overall === 'ok' ? 'All systems operational' : overall === 'degraded' ? 'Partly degraded' : 'Needs attention'}
      </p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 text-[11.5px]">
            <dt className="flex items-center gap-1.5 text-muted"><span className={cn('h-1.5 w-1.5 rounded-full', HEALTH_DOT[row.health])} />{row.label}</dt>
            <dd className="tabular-nums text-text">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function badgeFor(item: NavItem, counts: { working: number; approvals: number }): number {
  if (item.id === 'runs') return counts.working;
  if (item.id === 'home') return counts.approvals;
  return 0;
}

export function Sidebar() {
  const { view, setView, leftCollapsed, toggleLeft, snapshot, live } = useStudio();
  const counts = { working: live?.running.length ?? 0, approvals: snapshot?.approvals.filter((a) => a.status === 'pending').length ?? 0 };

  return (
    <aside className={cn('flex shrink-0 flex-col border-r border-line-soft bg-sidebar transition-[width] duration-200', leftCollapsed ? 'w-[60px]' : 'w-[224px]')}>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item, view);
          const planned = item.view === null;
          const badge = badgeFor(item, counts);
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" aria-label={item.label} aria-current={active ? 'page' : undefined}
              aria-disabled={planned || undefined} title={planned ? item.plannedReason : leftCollapsed ? item.label : undefined}
              onClick={() => { if (item.view) setView(item.view); }}
              className={cn('relative flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13.5px] transition-colors',
                active ? 'border border-brand/40 bg-selected text-text shadow-glow' : 'border border-transparent',
                !active && !planned && 'text-muted hover:bg-hover hover:text-text',
                planned && 'cursor-not-allowed text-faint')}>
              <Icon size={18} className="shrink-0" />
              {!leftCollapsed && <span className="truncate">{item.label}</span>}
              {!leftCollapsed && planned && <span className="ml-auto rounded-full border border-line px-1.5 text-[10px] text-faint">Soon</span>}
              {badge > 0 && (
                <span className={cn('rounded-full px-1.5 text-[10px] font-semibold text-ink-950',
                  item.id === 'runs' ? 'bg-st-running animate-rail' : 'bg-st-waiting', leftCollapsed ? 'absolute right-1 top-1' : 'ml-auto')}>{badge}</span>
              )}
              {planned && <span className="sr-only">{item.plannedReason}</span>}
            </button>
          );
        })}
      </nav>
      <div className="space-y-2 border-t border-line-soft p-2">
        <SystemStatus collapsed={leftCollapsed} />
        <button type="button" onClick={toggleLeft} className="flex h-8 w-full items-center gap-3 rounded-lg px-2.5 text-[12px] text-muted hover:bg-hover hover:text-text"
          aria-label={leftCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Ctrl+B">
          {leftCollapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={16} /> Collapse</>}
        </button>
      </div>
    </aside>
  );
}
