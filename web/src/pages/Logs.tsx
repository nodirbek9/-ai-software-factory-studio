import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_ROLE_INFO, AGENT_ROLES, type EventLevel, type StudioEvent } from '@asf/shared';
import { Download, ScrollText } from 'lucide-react';
import { ROLE_HUE } from '@/components/agentMeta';
import { Button, EmptyState, Field, Input, Panel, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const LEVEL_STYLE: Record<EventLevel, string> = {
  info: 'bg-st-running/15 text-st-running',
  warn: 'bg-st-waiting/15 text-st-waiting',
  error: 'bg-st-failed/15 text-st-failed',
  debug: 'bg-ink-700 text-muted',
};

function mergeEvents(previous: StudioEvent[], incoming: StudioEvent[], projectId: string): StudioEvent[] {
  const byId = new Map<number, StudioEvent>();
  for (const event of [...previous, ...incoming]) {
    if (event.projectId === projectId) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function eventTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

export function Logs() {
  const { currentProjectId, events: liveEvents, selectTask, setView } = useStudio();
  const [history, setHistory] = useState<{ projectId: string | null; events: StudioEvent[] }>({ projectId: null, events: [] });
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  const [level, setLevel] = useState('all');
  const [agent, setAgent] = useState('all');
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentProjectId) return;
    const controller = new AbortController();
    setLoadingProjectId(currentProjectId);
    setType('all');
    void api<StudioEvent[]>(`/api/projects/${encodeURIComponent(currentProjectId)}/events?limit=1000`, { signal: controller.signal })
      .then((events) => {
        if (controller.signal.aborted) return;
        setHistory((previous) => ({
          projectId: currentProjectId,
          events: mergeEvents(events, previous.projectId === currentProjectId ? previous.events : [], currentProjectId),
        }));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          useStudio.getState().setError(error instanceof Error ? error.message : 'Could not load activity logs.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingProjectId(null);
      });
    return () => controller.abort();
  }, [currentProjectId]);

  useEffect(() => {
    if (!currentProjectId) {
      setHistory({ projectId: null, events: [] });
      return;
    }
    setHistory((previous) => ({
      projectId: currentProjectId,
      events: mergeEvents(previous.projectId === currentProjectId ? previous.events : [], liveEvents, currentProjectId),
    }));
  }, [currentProjectId, liveEvents]);

  const events = useMemo(() => currentProjectId
    ? mergeEvents(history.projectId === currentProjectId ? history.events : [], liveEvents, currentProjectId)
    : [], [currentProjectId, history, liveEvents]);
  const types = useMemo(() => [...new Set(events.map((event) => event.type))].sort(), [events]);
  const filteredEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => (level === 'all' || event.level === level)
      && (agent === 'all' || event.role === agent)
      && (type === 'all' || event.type === type)
      && (showOutput || event.type !== 'agent.output')
      && (!query || [event.message, event.type, event.level, event.role ? AGENT_ROLE_INFO[event.role].name : 'System', event.taskId ?? '']
        .some((value) => value.toLowerCase().includes(query))));
  }, [events, level, agent, type, showOutput, search]);
  const rows = useMemo(() => filteredEvents.slice(-800), [filteredEvents]);

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [follow, rows]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(filteredEvents, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activity-${currentProjectId}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!currentProjectId) {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState icon={<ScrollText size={28} />} title="Select a project to view activity">
          <p>Open or create a project to see its activity logs.</p>
          <Button className="mt-4" onClick={() => setView('projects')}>Open projects</Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Activity logs</h1>
        <Button onClick={exportJson}><Download size={14} /> Export JSON</Button>
      </div>
      <Panel className="flex shrink-0 flex-wrap items-end gap-3 p-3">
        <Field label="Level">
          <Select value={level} onChange={(event) => setLevel(event.target.value)}>
            <option value="all">All levels</option>
            {(['info', 'warn', 'error', 'debug'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </Field>
        <Field label="Agent">
          <Select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="all">All agents</option>
            {AGENT_ROLES.map((role) => <option key={role} value={role}>{AGENT_ROLE_INFO[role].name}</option>)}
          </Select>
        </Field>
        <Field label="Type">
          <Select className="max-w-56" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="all">All types</option>
            {types.map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
        </Field>
        <div className="min-w-48 flex-1">
          <Field label="Search"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search activity…" /></Field>
        </div>
        <label className="flex h-8 items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" className="accent-brand" checked={showOutput} onChange={(event) => setShowOutput(event.target.checked)} />
          Show agent output
        </label>
        <label className="flex h-8 items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" className="accent-brand" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
      </Panel>
      <p className="text-[12px] text-muted" role="status">
        {rows.length} shown / {events.length} total rows · {filteredEvents.length} matching
        {filteredEvents.length > 800 && ' · Showing the latest 800 matches'}
        {loadingProjectId === currentProjectId && ' · Loading history…'}
      </p>
      <Panel className="flex min-h-48 flex-1 flex-col overflow-hidden">
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" aria-label="Activity log entries" aria-busy={loadingProjectId === currentProjectId}>
          {rows.length ? rows.map((event) => {
            const content = <>
              <time dateTime={event.createdAt} title={event.createdAt} className="font-mono text-[11px] text-muted">{eventTime(event.createdAt)}</time>
              <span className={cn('w-fit rounded-full px-2 py-0.5 text-[11px]', LEVEL_STYLE[event.level])}>{event.level}</span>
              <span className="text-[12px] text-muted" style={{ color: event.role ? ROLE_HUE[event.role] : undefined }}>
                {event.role ? AGENT_ROLE_INFO[event.role].name : 'System'}
              </span>
              <span className="min-w-0 break-all font-mono text-[11px] text-faint">{event.type}</span>
              <span className="col-span-full min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] text-text xl:col-span-1">{event.message}</span>
            </>;
            const className = 'grid w-full grid-cols-[64px_56px_minmax(100px,1fr)_minmax(100px,1fr)] items-start gap-x-3 gap-y-1 border-b border-line-soft px-3 py-2 text-left xl:grid-cols-[64px_56px_130px_160px_minmax(0,1fr)]';
            return event.taskId ? (
              <button key={event.id} type="button" className={cn(className, 'hover:bg-ink-800')} title="Open task in workflows"
                onClick={() => { selectTask(event.taskId); setView('workflows'); }}>{content}</button>
            ) : <div key={event.id} className={className}>{content}</div>;
          }) : (
            <EmptyState title={loadingProjectId === currentProjectId ? 'Loading activity' : events.length ? 'No matching activity' : 'No activity yet'}>
              {events.length ? 'Adjust the filters or search to see more events.' : 'Events will appear here when this project starts planning or running.'}
            </EmptyState>
          )}
        </div>
      </Panel>
    </div>
  );
}
