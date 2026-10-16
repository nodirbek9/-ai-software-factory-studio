import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AGENT_ROLE_INFO, type AgentSession, type EventLevel, type Run, type StudioEvent } from '@asf/shared';
import { ExternalLink, ScrollText, X } from 'lucide-react';
import { ROLE_HUE } from '@/components/agentMeta';
import { Button, EmptyState, ErrorState, Panel, Skeleton } from '@/components/ui/primitives';
import {
  buildLogQuery, downloadEvents, initialFilters, isHiddenOutput, logQueryKey, LogFilters, matchesFilters, type LogFilterState,
} from '@/features/logs/LogFilters';
import { fetchEvents, listSessions, LOG_PAGE_SIZE } from '@/features/logs/logsApi';
import { VirtualRows } from '@/features/logs/VirtualRows';
import { listRuns } from '@/features/workflows/workflowsApi';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const ROW_HEIGHT = 30;
const SEARCH_DEBOUNCE_MS = 300;

const LEVEL_STYLE: Record<EventLevel, string> = {
  info: 'bg-st-running/15 text-st-running',
  warn: 'bg-st-waiting/15 text-st-waiting',
  error: 'bg-st-failed/15 text-st-failed',
  debug: 'bg-ink-700 text-muted',
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const roleName = (event: StudioEvent): string => (event.role ? AGENT_ROLE_INFO[event.role].name : 'System');

function eventTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// ------------------------------------------------------------------ event list helpers (ids descending, newest first)

/** Merges two lists into one id-descending list without duplicates. */
function mergeEvents(a: StudioEvent[], b: StudioEvent[]): StudioEvent[] {
  const byId = new Map<number, StudioEvent>();
  for (const event of a) byId.set(event.id, event);
  for (const event of b) byId.set(event.id, event);
  return [...byId.values()].sort((x, y) => y.id - x.id);
}

/** Adds newer events on top; the common case (all ids above the current top) avoids re-sorting the whole list. */
function prependEvents(existing: StudioEvent[], fresh: StudioEvent[]): StudioEvent[] {
  const top = existing[0]?.id ?? -1;
  if (fresh.some((event) => event.id <= top)) return mergeEvents(existing, fresh);
  return [...mergeEvents(fresh, []), ...existing];
}

// ------------------------------------------------------------------ data hooks

interface LogData {
  events: StudioEvent[];
  nextBefore: number | null;
  /** Initial page of the current filters is loading. */
  loading: boolean;
  error: string | null;
  loadingMore: boolean;
  moreError: string | null;
}

const LOADING: LogData = { events: [], nextBefore: null, loading: true, error: null, loadingMore: false, moreError: null };

/** Loads the first page whenever the server-side filters change; `loadMore` follows `nextBefore` to older events. */
function useLogEvents(filters: LogFilterState) {
  const [data, setData] = useState<LogData>(LOADING);
  const dataRef = useRef(data);
  dataRef.current = data;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const baseQuery = useRef(buildLogQuery(filters, Date.now()));
  const token = useRef(0);
  const busy = useRef(false);
  const key = logQueryKey(filters);

  const load = useCallback(async () => {
    const id = ++token.current;
    busy.current = false;
    baseQuery.current = { ...buildLogQuery(filtersRef.current, Date.now()), limit: LOG_PAGE_SIZE };
    setData(LOADING);
    try {
      const page = await fetchEvents(baseQuery.current);
      if (id === token.current) setData({ ...LOADING, loading: false, events: mergeEvents(page.events, []), nextBefore: page.nextBefore });
    } catch (reason) {
      if (id === token.current) setData({ ...LOADING, loading: false, error: errorText(reason) });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { token.current += 1; };
  }, [key, load]);

  const loadMore = useCallback(async () => {
    const before = dataRef.current.nextBefore;
    if (busy.current || before === null) return;
    const id = token.current;
    busy.current = true;
    setData((current) => ({ ...current, loadingMore: true, moreError: null }));
    try {
      const page = await fetchEvents({ ...baseQuery.current, before });
      if (id === token.current) setData((current) => ({ ...current, loadingMore: false, events: mergeEvents(current.events, page.events), nextBefore: page.nextBefore }));
    } catch (reason) {
      if (id === token.current) setData((current) => ({ ...current, loadingMore: false, moreError: errorText(reason) }));
    } finally {
      if (id === token.current) busy.current = false;
    }
  }, []);

  const prepend = useCallback((fresh: StudioEvent[]) => {
    setData((current) => ({ ...current, events: prependEvents(current.events, fresh) }));
  }, []);

  return { data, reload: load, loadMore, prepend, queryKey: key };
}

/**
 * Watches the studio SSE stream. Events that match the filters go straight into the list while live tail is on;
 * while it is paused they are only counted until the user asks for them.
 */
function useLiveTail(filters: LogFilterState, live: boolean, queryKey: string, onEvents: (events: StudioEvent[]) => void) {
  const [count, setCount] = useState(0);
  const pending = useRef<StudioEvent[]>([]);
  const latest = useRef({ filters, live, onEvents });
  latest.current = { filters, live, onEvents };

  useEffect(() => {
    pending.current = [];
    setCount(0);
  }, [queryKey]);

  useEffect(() => {
    let seen = useStudio.getState().events.at(-1)?.id ?? 0;
    return useStudio.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const fresh = state.events.filter((event) => event.id > seen);
      for (const event of fresh) seen = Math.max(seen, event.id);
      const matching = fresh.filter((event) => matchesFilters(event, latest.current.filters));
      if (matching.length === 0) return;
      if (latest.current.live) {
        latest.current.onEvents(matching);
      } else {
        pending.current = mergeEvents(pending.current, matching);
        setCount(pending.current.length);
      }
    });
  }, []);

  const flush = useCallback(() => {
    const items = pending.current;
    pending.current = [];
    setCount(0);
    if (items.length) latest.current.onEvents(items);
  }, []);

  useEffect(() => { if (live) flush(); }, [live, flush]);

  return { pending: count, flush };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Runs and sessions of the filtered project, for the two dependent selects. */
function useProjectLists(projectId: string): { runs: Run[]; sessions: AgentSession[] } {
  const [runs, setRuns] = useState<Run[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  useEffect(() => {
    setRuns([]);
    setSessions([]);
    if (!projectId) return undefined;
    let cancelled = false;
    listRuns(projectId).then((page) => { if (!cancelled) setRuns(page.runs); }, () => undefined);
    listSessions(projectId).then((list) => { if (!cancelled) setSessions(list); }, () => undefined);
    return () => { cancelled = true; };
  }, [projectId]);
  return { runs, sessions };
}

// ------------------------------------------------------------------ rows and details

function LogRow({ event, selected, onSelect, onOpenTask }: { event: StudioEvent; selected: boolean; onSelect: () => void; onOpenTask: (taskId: string) => void }) {
  return (
    <div className={cn('flex h-full items-center border-b border-line-soft', selected && 'bg-brand/10')}>
      <button type="button" aria-pressed={selected} onClick={onSelect}
        className="grid h-full min-w-0 flex-1 grid-cols-[100px_52px_minmax(0,1fr)] items-center gap-x-3 px-3 text-left hover:bg-ink-800 md:grid-cols-[100px_52px_150px_100px_minmax(0,1fr)]">
        <time dateTime={event.createdAt} title={event.createdAt} className="font-mono text-[11px] text-muted">{eventTime(event.createdAt)}</time>
        <span className={cn('w-fit rounded-full px-2 py-0.5 text-[11px]', LEVEL_STYLE[event.level])}>{event.level}</span>
        <span className="hidden truncate font-mono text-[11px] text-faint md:block" title={event.type}>{event.type}</span>
        <span className="hidden truncate text-[12px] text-muted md:block" style={{ color: event.role ? ROLE_HUE[event.role] : undefined }}>{roleName(event)}</span>
        <span className="truncate font-mono text-[12px] text-text" title={event.message}>{event.message}</span>
      </button>
      {event.taskId && (
        <button type="button" aria-label="Open task in workflows" title="Open task in workflows" onClick={() => onOpenTask(event.taskId as string)}
          className="mx-2 grid h-6 w-6 shrink-0 place-items-center rounded text-muted hover:bg-ink-700 hover:text-text">
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</dt>
      <dd className="break-words text-[12.5px] text-text">{children}</dd>
    </div>
  );
}

function EventDetails({ event, onClose, onOpenTask }: { event: StudioEvent; onClose: () => void; onOpenTask: (taskId: string) => void }) {
  return (
    <aside aria-label="Event details" className="flex max-h-80 min-h-0 w-full shrink-0 flex-col rounded-xl border border-line-soft bg-surface lg:max-h-none lg:w-96">
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-2.5">
        <h2 className="text-[13px] font-semibold">Event #{event.id}</h2>
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-ink-800 hover:text-text"><X size={15} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <dl className="space-y-3">
          <Detail label="Time"><time dateTime={event.createdAt}>{event.createdAt}</time></Detail>
          <Detail label="Level"><span className={cn('rounded-full px-2 py-0.5 text-[11px]', LEVEL_STYLE[event.level])}>{event.level}</span></Detail>
          <Detail label="Type"><span className="font-mono">{event.type}</span></Detail>
          <Detail label="Agent">{roleName(event)}</Detail>
          {event.taskId && <Detail label="Task"><span className="font-mono">{event.taskId}</span></Detail>}
          <Detail label="Message"><span className="whitespace-pre-wrap font-mono">{event.message || '—'}</span></Detail>
        </dl>
        {event.taskId && (
          <Button size="sm" onClick={() => onOpenTask(event.taskId as string)}><ExternalLink size={13} />Open task in workflows</Button>
        )}
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Data</p>
          {event.data
            ? <pre aria-label="Event data" className="max-h-96 overflow-auto rounded-md border border-line-soft bg-ink-950 p-3 font-mono text-[11.5px] text-text">{JSON.stringify(event.data, null, 2)}</pre>
            : <p className="text-[12.5px] text-muted">This event carries no data.</p>}
        </div>
      </div>
    </aside>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading events">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => <Skeleton key={n} className="h-5 w-full" />)}
    </div>
  );
}

// ------------------------------------------------------------------ page

export function Logs() {
  const headerProject = useStudio((state) => state.currentProjectId) ?? '';
  const projects = useStudio((state) => state.projects);
  const selectTask = useStudio((state) => state.selectTask);
  const setView = useStudio((state) => state.setView);
  const [filters, setFilters] = useState<LogFilterState>(() => initialFilters(headerProject));
  const [live, setLive] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // The header project selector is the default; picking another project there moves this page along.
  useEffect(() => {
    setFilters((current) => (current.project === headerProject ? current : { ...current, project: headerProject, run: '', session: '' }));
  }, [headerProject]);

  const search = useDebounced(filters.search, SEARCH_DEBOUNCE_MS);
  const type = useDebounced(filters.type, SEARCH_DEBOUNCE_MS);
  const effective = useMemo(() => ({ ...filters, search, type }), [filters, search, type]);

  const { data, reload, loadMore, prepend, queryKey } = useLogEvents(effective);
  const { pending, flush } = useLiveTail(effective, live, queryKey, prepend);
  const { runs, sessions } = useProjectLists(filters.project);

  const visible = useMemo(() => data.events.filter((event) => !isHiddenOutput(event, effective)), [data.events, effective]);
  const selected = useMemo(() => (selectedId === null ? null : visible.find((event) => event.id === selectedId) ?? null), [visible, selectedId]);

  const openTask = useCallback((taskId: string) => { selectTask(taskId); setView('workflows'); }, [selectTask, setView]);
  const exportJson = () => downloadEvents(visible, filters.project || 'all');
  const patchFilters = (patch: Partial<LogFilterState>) => setFilters((current) => ({ ...current, ...patch }));
  const hasFilters = Boolean(filters.run || filters.session || filters.role || filters.level || filters.type.trim() || filters.search.trim() || filters.range !== 'all');
  const hiddenCount = data.events.length - visible.length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Activity logs</h1>
      <LogFilters value={filters} onChange={patchFilters} projects={projects} runs={runs} sessions={sessions} live={live} onLive={setLive}
        pending={pending} onShowPending={flush} onExport={exportJson} exportCount={visible.length} />
      <p className="text-[12px] text-muted" role="status">
        {data.loading ? 'Loading events…' : `${visible.length} events loaded${hiddenCount > 0 ? ` (${hiddenCount} agent output lines hidden)` : ''}`}
        {!data.loading && !data.error && (data.nextBefore !== null ? ' · older events available' : ' · start of the log reached')}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <Panel className="flex min-h-48 min-w-0 flex-1 flex-col overflow-hidden">
          {data.loading && <ListSkeleton />}
          {data.error && <ErrorState title="Could not load events" message={data.error} onRetry={() => void reload()} />}
          {!data.loading && !data.error && visible.length === 0 && (
            <EmptyState icon={<ScrollText size={28} />} title={hasFilters ? 'No events match these filters' : 'No activity yet'}>
              {hasFilters ? 'Widen the time range or clear a filter.' : 'Events appear here when a project starts planning or running.'}
            </EmptyState>
          )}
          {!data.loading && !data.error && visible.length > 0 && (
            <>
              <VirtualRows items={visible} rowHeight={ROW_HEIGHT} ariaLabel="Activity log entries" className="flex-1" getKey={(event) => event.id}
                onEndReached={() => void loadMore()}
                renderRow={(event) => <LogRow event={event} selected={event.id === selectedId} onSelect={() => setSelectedId(event.id)} onOpenTask={openTask} />} />
              {(data.nextBefore !== null || data.moreError) && (
                <div className="flex items-center justify-center gap-3 border-t border-line-soft px-3 py-2">
                  {data.moreError && <span role="alert" className="text-[12px] text-st-failed">Could not load older events: {data.moreError}</span>}
                  <Button size="sm" disabled={data.loadingMore || data.nextBefore === null} onClick={() => void loadMore()}>
                    {data.loadingMore ? 'Loading…' : 'Load older'}
                  </Button>
                </div>
              )}
            </>
          )}
        </Panel>
        {selected && <EventDetails event={selected} onClose={() => setSelectedId(null)} onOpenTask={openTask} />}
      </div>
    </div>
  );
}
