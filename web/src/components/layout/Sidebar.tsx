import { Activity, Bot, Radar, Cpu, FolderGit2, FolderTree, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Settings, Workflow, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStudio, type View } from '@/store/studio';

const NAV: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'monitor', label: 'Live monitor', icon: Radar },
  { view: 'projects', label: 'Projects', icon: FolderGit2 },
  { view: 'agents', label: 'Agents', icon: Bot },
  { view: 'workflows', label: 'Workflows', icon: Workflow },
  { view: 'files', label: 'File explorer', icon: FolderTree },
  { view: 'logs', label: 'Activity logs', icon: Activity },
  { view: 'providers', label: 'Model providers', icon: Cpu },
  { view: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const { view, setView, leftCollapsed, toggleLeft, connection, snapshot, live } = useStudio();
  const working = live?.running.length ?? 0;
  const pending = snapshot?.approvals.filter((a) => a.status === 'pending').length ?? 0;

  return (
    <aside className={cn('flex shrink-0 flex-col border-r border-line-soft bg-ink-900/70 transition-[width] duration-200', leftCollapsed ? 'w-[60px]' : 'w-[220px]')}>
      <div className="flex h-14 items-center gap-2.5 px-3.5">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand-2 text-[13px] font-bold text-ink-950">AF</div>
        {!leftCollapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">Software Factory</div>
            <div className="truncate text-[11px] text-muted">Agent studio</div>
          </div>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Main">
        {NAV.map(({ view: target, label, icon: Icon }) => {
          const active = view === target;
          return (
            <button key={target} onClick={() => setView(target)} title={leftCollapsed ? label : undefined} aria-label={label} aria-current={active ? "page" : undefined}
              className={cn('relative flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors',
                active ? 'bg-ink-800 text-text' : 'text-muted hover:bg-ink-850 hover:text-text')}>
              {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-brand" />}
              <Icon size={17} className="shrink-0" />
              {!leftCollapsed && <span className="truncate">{label}</span>}
              {target === 'monitor' && working > 0 && (
                <span className={cn('rounded-full bg-st-running px-1.5 text-[10px] font-semibold text-ink-950 animate-rail', leftCollapsed ? 'absolute right-1 top-1' : 'ml-auto')}>{working}</span>
              )}
              {target === 'dashboard' && pending > 0 && (
                <span className={cn('rounded-full bg-st-waiting px-1.5 text-[10px] font-semibold text-ink-950', leftCollapsed ? 'absolute right-1 top-1' : 'ml-auto')}>{pending}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-line-soft p-2">
        <div className={cn('mb-1 flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted', leftCollapsed && 'justify-center px-0')} title={`Live connection: ${connection}`}>
          <span className={cn('h-2 w-2 rounded-full', connection === 'live' ? 'bg-st-completed' : connection === 'connecting' ? 'bg-st-waiting animate-rail' : 'bg-st-failed')} />
          {!leftCollapsed && (connection === 'live' ? 'Live updates on' : connection === 'connecting' ? 'Connecting…' : 'Server offline')}
        </div>
        <button onClick={toggleLeft} className="flex h-8 w-full items-center gap-3 rounded-lg px-2.5 text-[12px] text-muted hover:bg-ink-850 hover:text-text" aria-label={leftCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {leftCollapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={16} /> Collapse</>}
        </button>
      </div>
    </aside>
  );
}
