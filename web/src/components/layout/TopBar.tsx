import { useEffect, useMemo, useState } from 'react';
import { Bell, Download, Layers, Pause, Play, Search, Sparkles, Square } from 'lucide-react';
import { getToken } from '@/lib/api';
import { cn, statusMeta, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { Button, Kbd, Progress, StatusBadge } from '@/components/ui/primitives';

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="hidden min-w-[78px] flex-col leading-tight lg:flex">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={cn('text-[15px] font-semibold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

const SEEN_KEY = 'asf.notifications.seen';

/** Highest event id the person has already looked at (survives reloads; 0 when storage is unavailable). */
function readSeen(): number {
  try {
    const value = Number(localStorage.getItem(SEEN_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeSeen(id: number): void {
  try { localStorage.setItem(SEEN_KEY, String(id)); } catch { /* storage unavailable — the badge resets on reload */ }
}

async function downloadReport(projectId: string, slug: string): Promise<void> {
  const token = getToken();
  const response = await fetch(`/api/projects/${projectId}/report.md`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Report is not available yet');
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: `${slug}-report.md` });
  link.click();
  URL.revokeObjectURL(url);
}

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { live: liveState, projects, currentProjectId, selectProject, snapshot, events, startPlanning, pause, resume, cancelProject, setView, setError } = useStudio();
  const [bellOpen, setBellOpen] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  const project = snapshot?.project;
  const tasks = snapshot?.tasks ?? [];
  const done = tasks.filter((t) => t.status === 'completed').length;
  const running = tasks.filter((t) => t.status === 'running').length;
  const activeAgents = snapshot?.agents.filter((a) => a.status === 'running' || a.status === 'planning').length ?? 0;
  const pending = snapshot?.approvals.filter((a) => a.status === 'pending') ?? [];

  const notifications = useMemo(() => {
    const alerts = events.filter((e) => e.projectId === currentProjectId && (e.level === 'error' || e.level === 'warn') && e.type !== 'agent.output');
    return alerts.slice(-12).reverse();
  }, [events, currentProjectId]);

  const unseen = notifications.filter((e) => e.id > seen).length;
  // While the dropdown is open everything that arrives is on screen, so it counts as seen.
  useEffect(() => {
    if (!bellOpen) return;
    const latest = events.at(-1)?.id ?? 0;
    if (latest > seen) { setSeen(latest); writeSeen(latest); }
  }, [bellOpen, events, seen]);

  const status = project?.status;
  const live = status === 'planning' || status === 'running' || status === 'awaiting_approval';

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line-soft bg-sidebar px-4 2xl:h-16">
      <div className="flex shrink-0 items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-accent-from to-accent-to text-white shadow-glow"><Layers size={18} /></div>
        <div className="hidden leading-tight md:block">
          <div className="text-[14.5px] font-semibold">Software Factory Agent Studio <span className="text-brand-violet">V2</span></div>
          <div className="hidden text-[11.5px] text-muted xl:block">AI agents · Code · Test · Secure · Ship</div>
        </div>
      </div>
      {/* The picker shrinks (and truncates) instead of spilling its text over the search box on narrow windows. */}
      <div className="flex min-w-[9rem] shrink items-center gap-3 overflow-hidden">
        <select value={currentProjectId ?? ''} onChange={(e) => void selectProject(e.target.value || null)} aria-label="Current project"
          title={project?.name}
          className="h-8 w-full min-w-0 max-w-[240px] truncate rounded-md border border-line bg-ink-850 px-2 text-[13px] font-medium focus:border-brand focus:outline-none">
          {!currentProjectId && <option value="">{projects.length ? 'Select a project' : 'No projects yet'}</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {project && <span className="shrink-0"><StatusBadge status={project.status} /></span>}
      </div>

      {project && (
        <div className="hidden w-52 shrink-0 flex-col gap-1 xl:flex">
          <div className="flex justify-between text-[11px] text-muted"><span>Verified progress</span><span className="tabular-nums">{done}/{tasks.length} tasks</span></div>
          <Progress value={tasks.length ? done / tasks.length : 0} color={statusMeta(project.status).color} />
        </div>
      )}
      <button type="button" onClick={onOpenPalette} aria-label="Search and commands (Ctrl+K)"
        className="hidden h-8 min-w-[160px] flex-1 items-center gap-2 rounded-md border border-line bg-ink-950/60 px-2.5 text-left text-[12.5px] text-faint hover:border-brand/50 hover:text-muted lg:flex lg:max-w-[420px]">
        <Search size={14} /><span className="flex-1 truncate">Search pages, projects, actions…</span><Kbd>Ctrl</Kbd><Kbd>K</Kbd>
      </button>
      <Metric label="Active agents" value={String(activeAgents)} tone={activeAgents ? 'text-st-running' : undefined} />
      <Metric label="Running tasks" value={String(running)} />

      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => setView('monitor')} title="Open Runs (live monitor)"
          className={cn('hidden items-center gap-2 rounded-full border px-3 py-1 text-[12px] sm:inline-flex',
            liveState?.running.length ? 'border-st-running/40 bg-st-running/10 text-st-running' : 'border-line text-muted hover:text-text')}>
          <span className={cn('h-2 w-2 rounded-full', liveState?.running.length ? 'bg-st-running animate-rail' : 'bg-st-idle')} />
          {liveState?.running.length ? `${liveState.running.length} agent${liveState.running.length > 1 ? 's' : ''} working` : 'No agent working'}
        </button>
        <div className="relative">
          <Button variant="ghost" size="icon" onClick={() => setBellOpen((open) => !open)} aria-label="Notifications">
            <Bell size={17} />
            {(pending.length > 0 || unseen > 0) && (
              <span data-testid="notification-dot" className={cn('absolute right-1.5 top-1.5 h-2 w-2 rounded-full', pending.length ? 'bg-st-waiting' : 'bg-st-failed')} />
            )}
          </Button>
          {bellOpen && (
            <div className="absolute right-0 top-10 z-30 w-80 rounded-xl border border-line bg-ink-900 p-2 shadow-2xl shadow-black/50" onMouseLeave={() => setBellOpen(false)}>
              {pending.map((a) => (
                <button key={a.id} onClick={() => { setBellOpen(false); setView('dashboard'); }} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-ink-800">
                  <div className="text-[12px] font-medium text-st-waiting">Waiting for your approval</div>
                  <div className="text-[12px] text-text">{a.title}</div>
                </button>
              ))}
              {notifications.map((e) => (
                <div key={e.id} className="rounded-lg px-2.5 py-1.5">
                  <div className={cn('text-[12px]', e.level === 'error' ? 'text-st-failed' : 'text-st-waiting')}>{e.message.slice(0, 140)}</div>
                  <div className="text-[11px] text-faint">{timeAgo(e.createdAt)}</div>
                </div>
              ))}
              {!pending.length && !notifications.length && <p className="px-2.5 py-3 text-[12px] text-muted">Nothing needs your attention.</p>}
            </div>
          )}
        </div>

        {project && status === 'draft' && <Button variant="primary" onClick={() => void startPlanning()}><Sparkles size={15} /> Generate plan</Button>}
        {project && live && <Button onClick={() => void pause()}><Pause size={15} /> Pause</Button>}
        {project && status === 'paused' && <Button variant="primary" onClick={() => void resume()}><Play size={15} /> Resume</Button>}
        {project && (live || status === 'paused') && (
          <Button variant="ghost" size="icon" title="Stop project" aria-label="Stop project"
            onClick={() => { if (window.confirm('Stop this project? Running tasks are cancelled; completed work stays on the integration branch.')) void cancelProject(); }}>
            <Square size={15} />
          </Button>
        )}
        {project?.reportMarkdown && (
          <Button onClick={() => downloadReport(project.id, project.slug).catch((e: Error) => setError(e.message))}><Download size={15} /> Report</Button>
        )}
        {!project && <Button variant="primary" onClick={() => setView('projects')}>New project</Button>}
      </div>
    </header>
  );
}
