import { AGENT_ROLE_INFO, AGENT_ROLES, type AgentRole, type AgentSession, type EventLevel, type LogQuery, type Project, type Run, type StudioEvent } from '@asf/shared';
import { Download, Radio, Search } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export type LogRange = 'all' | '15m' | '1h' | '24h' | '7d';

export const LOG_RANGES: { id: LogRange; label: string; ms: number | null }[] = [
  { id: 'all', label: 'All time', ms: null },
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
];

export const TYPE_SUGGESTIONS = ['task.*', 'run.*', 'session.*', 'agent.*', 'approval.*', 'git.*', 'quality.*', 'findings.*'];
const LEVELS: EventLevel[] = ['info', 'warn', 'error', 'debug'];

export interface LogFilterState {
  /** '' = all projects. */
  project: string;
  /** '' = all runs / sessions (they only apply to a chosen project). */
  run: string;
  session: string;
  role: AgentRole | '';
  level: EventLevel | '';
  /** Exact type or a '.*' prefix; '' = all. */
  type: string;
  search: string;
  range: LogRange;
  /** Client-side: agent.output lines are numerous and hidden unless asked for (V1 behaviour). */
  showOutput: boolean;
}

export function initialFilters(project: string): LogFilterState {
  return { project, run: '', session: '', role: '', level: '', type: '', search: '', range: 'all', showOutput: false };
}

/** Everything that changes what the server returns (showOutput only filters what is already loaded). */
export function logQueryKey(filters: LogFilterState): string {
  return JSON.stringify({ ...filters, showOutput: false });
}

/** Only set filters are sent. `from` is computed from `now` so a reload keeps "last hour" meaning the last hour. */
export function buildLogQuery(filters: LogFilterState, now: number): LogQuery {
  const query: LogQuery = {};
  if (filters.project) query.projectId = filters.project;
  if (filters.run) query.runId = filters.run;
  if (filters.session) query.sessionId = filters.session;
  if (filters.role) query.role = filters.role;
  if (filters.level) query.level = filters.level;
  if (filters.type.trim()) query.type = filters.type.trim();
  if (filters.search.trim()) query.q = filters.search.trim();
  const range = LOG_RANGES.find((item) => item.id === filters.range);
  if (range?.ms) query.from = new Date(now - range.ms).toISOString();
  return query;
}

function matchesType(type: string, filter: string): boolean {
  if (!filter) return true;
  return filter.endsWith('.*') ? type.startsWith(filter.slice(0, -1)) : type === filter;
}

function dataId(event: StudioEvent, key: 'runId' | 'sessionId'): string | null {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : null;
}

/** True when agent.output lines must stay hidden for these filters. */
export function isHiddenOutput(event: StudioEvent, filters: LogFilterState): boolean {
  return !filters.showOutput && event.type === 'agent.output' && filters.type.trim() !== 'agent.output';
}

/**
 * Client-side mirror of the server filters for live-tail events. Run and session filters need the id in the event
 * data; an event without it cannot be shown to belong to that run/session, so it is left out. The time range is not
 * checked: a live event is always recent.
 */
export function matchesFilters(event: StudioEvent, filters: LogFilterState): boolean {
  if (filters.project && event.projectId !== filters.project) return false;
  if (filters.run && dataId(event, 'runId') !== filters.run) return false;
  if (filters.session && dataId(event, 'sessionId') !== filters.session) return false;
  if (filters.role && event.role !== filters.role) return false;
  if (filters.level && event.level !== filters.level) return false;
  if (!matchesType(event.type, filters.type.trim())) return false;
  const query = filters.search.trim().toLowerCase();
  if (query && !event.message.toLowerCase().includes(query)) return false;
  return !isHiddenOutput(event, filters);
}

/** Downloads the given events as pretty JSON, exactly as received (the server already redacted `data`). */
export function downloadEvents(events: StudioEvent[], label: string): void {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `activity-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ toolbar

export interface LogFiltersProps {
  value: LogFilterState;
  onChange: (patch: Partial<LogFilterState>) => void;
  projects: Project[];
  runs: Run[];
  sessions: AgentSession[];
  live: boolean;
  onLive: (live: boolean) => void;
  /** Matching events that arrived while live tail was paused. */
  pending: number;
  onShowPending: () => void;
  onExport: () => void;
  exportCount: number;
}

export function LogFilters({ value, onChange, projects, runs, sessions, live, onLive, pending, onShowPending, onExport, exportCount }: LogFiltersProps) {
  const noProject = !value.project;
  const runHint = noProject ? 'Select a project to filter by run' : runs.length ? undefined : 'This project has no runs yet';
  const sessionHint = noProject ? 'Select a project to filter by session' : sessions.length ? undefined : 'This project has no sessions yet';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Project" className="w-40" value={value.project} onChange={(e) => onChange({ project: e.target.value, run: '', session: '' })}>
        <option value="">All projects</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select>
      <Select aria-label="Run" className="w-32" title={runHint} disabled={noProject || runs.length === 0} value={value.run} onChange={(e) => onChange({ run: e.target.value })}>
        <option value="">All runs</option>
        {runs.map((run) => <option key={run.id} value={run.id}>Run #{run.number}</option>)}
      </Select>
      <Select aria-label="Session" className="w-40" title={sessionHint} disabled={noProject || sessions.length === 0} value={value.session} onChange={(e) => onChange({ session: e.target.value })}>
        <option value="">All sessions</option>
        {sessions.map((session) => <option key={session.id} value={session.id}>#{session.number} {session.title}</option>)}
      </Select>
      <Select aria-label="Role" className="w-32" value={value.role} onChange={(e) => onChange({ role: e.target.value as AgentRole | '' })}>
        <option value="">All roles</option>
        {AGENT_ROLES.map((role) => <option key={role} value={role}>{AGENT_ROLE_INFO[role].name}</option>)}
      </Select>
      <Select aria-label="Level" className="w-28" value={value.level} onChange={(e) => onChange({ level: e.target.value as EventLevel | '' })}>
        <option value="">All levels</option>
        {LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
      </Select>
      <Input aria-label="Event type" list="log-type-suggestions" className="w-36" placeholder="Type (task.*)" value={value.type} onChange={(e) => onChange({ type: e.target.value })} />
      <datalist id="log-type-suggestions">{TYPE_SUGGESTIONS.map((type) => <option key={type} value={type} />)}</datalist>
      <div className="relative w-48">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" aria-hidden="true" />
        <Input aria-label="Search logs" className="pl-8" placeholder="Search messages" value={value.search} onChange={(e) => onChange({ search: e.target.value })} />
      </div>
      <Select aria-label="Time range" className="w-40" value={value.range} onChange={(e) => onChange({ range: e.target.value as LogRange })}>
        {LOG_RANGES.map((range) => <option key={range.id} value={range.id}>{range.label}</option>)}
      </Select>
      <label className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
        <input type="checkbox" className="accent-brand" checked={value.showOutput} onChange={(e) => onChange({ showOutput: e.target.checked })} />
        Show agent output
      </label>
      <div className="ml-auto flex items-center gap-2">
        {!live && pending > 0 && (
          <Button size="sm" variant="primary" onClick={onShowPending}>{pending} new event{pending === 1 ? '' : 's'}</Button>
        )}
        <button type="button" aria-pressed={live} onClick={() => onLive(!live)} title={live ? 'New events are added as they arrive' : 'Paused: new events are only counted'}
          className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium transition-colors',
            live ? 'border-st-completed/40 bg-st-completed/15 text-st-completed' : 'border-line bg-ink-800 text-muted hover:text-text')}>
          <Radio size={13} aria-hidden="true" />Live tail
        </button>
        <Button onClick={onExport} disabled={exportCount === 0} title={exportCount === 0 ? 'No loaded events to export' : `Download the ${exportCount} loaded events as JSON`}>
          <Download size={14} />Export JSON
        </Button>
      </div>
    </div>
  );
}
