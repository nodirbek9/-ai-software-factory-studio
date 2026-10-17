import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search, ShieldCheck } from 'lucide-react';
import {
  FINDING_SEVERITIES, type Finding, type FindingQuery, type FindingSeverity, type FindingSource, type FindingStatus, type FindingsResponse,
  type QualityOverview, type Run, type ScannerInfo, type StudioEvent, type TestRunRow,
} from '@asf/shared';
import { Button, EmptyState, ErrorState, Input, Panel, PanelHeader, Select, Skeleton } from '@/components/ui/primitives';
import { FindingDrawer } from '@/features/quality/FindingDrawer';
import { FindingsTable, SEVERITY_LABEL, SEVERITY_TONE, SOURCE_LABEL, STATUS_LABEL } from '@/features/quality/FindingsTable';
import { getQuality, listFindings, requestAudit } from '@/features/quality/qualityApi';
import { ReadinessStrip } from '@/features/quality/ReadinessStrip';
import { formatMs } from '@/features/workflows/RunPanel';
import { listRuns } from '@/features/workflows/workflowsApi';
import { cn, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const SEARCH_DEBOUNCE_MS = 250;
const LIVE_THROTTLE_MS = 1000;
const FINDINGS_LIMIT = 200;
const LIVE_TYPES = ['findings.updated', 'quality.audit', 'task.updated'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------ data hooks

/** Loads `load()` whenever `key` changes (data resets); `reload` re-fetches in place so live updates keep the data on screen. */
function useFetched<T>(load: () => Promise<T>, key: string, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const id = ++seq.current;
    try {
      const result = await loadRef.current();
      if (id === seq.current) { setData(result); setError(null); }
    } catch (reason) {
      if (id === seq.current) setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    if (enabled) void reload();
    return () => { seq.current += 1; };
  }, [key, enabled, reload]);

  return { data, error, reload };
}

function useProjectRuns(projectId: string): { runs: Run[]; reload: () => void } {
  const [runs, setRuns] = useState<Run[]>([]);
  const reload = useCallback(() => {
    if (!projectId) { setRuns([]); return; }
    listRuns(projectId).then((page) => setRuns(page.runs), () => setRuns([]));
  }, [projectId]);
  useEffect(() => { setRuns([]); reload(); }, [reload]);
  return { runs, reload };
}

/** Re-fetches at most once a second when a findings/quality/task/run event of this project arrives on the SSE stream. */
function useLiveRefresh(projectId: string, onQuality: () => void, onRuns: () => void): void {
  const handlers = useRef({ projectId, onQuality, onRuns });
  handlers.current = { projectId, onQuality, onRuns };

  useEffect(() => {
    let seen = useStudio.getState().events.at(-1)?.id ?? 0;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let runsDirty = false;
    const fire = () => {
      timer = null;
      last = Date.now();
      handlers.current.onQuality();
      if (runsDirty) { runsDirty = false; handlers.current.onRuns(); }
    };
    const handle = (event: StudioEvent) => {
      const isRun = event.type.startsWith('run.');
      if (!isRun && !LIVE_TYPES.includes(event.type)) return;
      const filter = handlers.current.projectId;
      if (!filter || (event.projectId && event.projectId !== filter)) return;
      if (isRun) runsDirty = true;
      if (!timer) timer = setTimeout(fire, Math.max(0, LIVE_THROTTLE_MS - (Date.now() - last)));
    };
    const unsubscribe = useStudio.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const fresh = state.events.filter((event) => event.id > seen);
      for (const event of fresh) seen = Math.max(seen, event.id);
      fresh.forEach(handle);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, []);
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ------------------------------------------------------------------ test runs

function TestRunItem({ row }: { row: TestRunRow }) {
  const [open, setOpen] = useState(false);
  const { result } = row;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-test-run={row.taskId} className="border-b border-line-soft/60 px-4 py-2.5 text-[12.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{row.title}</span>
        <code className="text-faint">{row.taskKey}</code>
        <span className={result.passed ? 'text-st-completed' : 'text-st-failed'}>{result.passed ? 'Passed' : 'Failed'} · exit {result.exitCode ?? '—'}</span>
        <span className="text-muted">{formatMs(result.durationMs)}</span>
        {row.finishedAt && <span className="text-faint">{timeAgo(row.finishedAt)}</span>}
      </div>
      <p className="mt-0.5 break-words text-muted"><code>{result.command}</code> — {result.summary || 'no summary'}</p>
      {result.outputTail ? (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mt-1 inline-flex items-center gap-1 text-[12px] text-brand-2 hover:underline">
            <Chevron size={12} aria-hidden="true" />Output
          </button>
          {open && <pre aria-label={`Output of ${row.taskKey}`} className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-soft bg-ink-950 p-2 font-mono text-[11.5px]">{result.outputTail}</pre>}
        </>
      ) : <p className="mt-1 text-[12px] text-faint">No output recorded.</p>}
    </li>
  );
}

function TestRuns({ rows }: { rows: TestRunRow[] }) {
  return (
    <Panel role="region" aria-label="Test runs">
      <PanelHeader title="Test runs" />
      {rows.length === 0
        ? <p className="px-4 py-4 text-[13px] text-muted">No test run recorded for this run yet.</p>
        : <ul>{rows.map((row) => <TestRunItem key={row.taskId} row={row} />)}</ul>}
    </Panel>
  );
}

// ------------------------------------------------------------------ scanners + audit

/** Why "Run dependency audit" cannot be pressed, or null when it can. */
export function auditBlocker(overview: QualityOverview, requested: boolean): string | null {
  if (overview.pendingAuditApprovalId || requested) return 'An audit is already waiting for your approval.';
  const scanner = overview.scanners.find((item) => item.id === 'npm-audit');
  if (!scanner) return 'npm audit status was not reported for this project.';
  return scanner.available ? null : scanner.note || 'npm audit is not available on this machine.';
}

function AuditControl({ projectId, overview, onRequested }: { projectId: string; overview: QualityOverview; onRequested: () => void }) {
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setRequested(false); setError(null); }, [projectId]);
  // Once the server reports the pending approval it drives the state, so a decided approval re-enables the button.
  useEffect(() => { if (overview.pendingAuditApprovalId) setRequested(false); }, [overview.pendingAuditApprovalId]);
  const blocker = auditBlocker(overview, requested);
  const waiting = Boolean(overview.pendingAuditApprovalId) || requested;

  const start = async () => {
    if (!window.confirm('Run npm audit? It needs network access, so it is sent to Approvals and only runs after you approve it.')) return;
    setBusy(true);
    setError(null);
    try { await requestAudit(projectId); setRequested(true); onRequested(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {waiting && <span role="status" className="text-[12px] text-st-waiting">Waiting for your approval in Approvals</span>}
      {!waiting && blocker && <span className="max-w-xs text-right text-[11.5px] text-faint">{blocker}</span>}
      {error && <span role="alert" className="text-[12px] text-st-failed">{error}</span>}
      <Button size="sm" disabled={busy || blocker !== null} title={blocker ?? undefined} onClick={() => void start()}>Run dependency audit</Button>
    </div>
  );
}

function ScannerRow({ scanner }: { scanner: ScannerInfo }) {
  const guardian = scanner.id === 'guardian' && !scanner.available;
  return (
    <li data-scanner={scanner.id} className="grid gap-x-3 gap-y-0.5 border-b border-line-soft/60 px-4 py-2.5 text-[12.5px] last:border-b-0 sm:grid-cols-[180px_100px_90px_110px_1fr]">
      <span className="font-medium">{scanner.label}</span>
      <span className={scanner.available ? 'text-st-completed' : 'text-st-idle'}>{scanner.available ? 'Available' : 'Unavailable'}</span>
      <span className="text-muted">{scanner.version ?? '—'}</span>
      <span className="text-muted">{scanner.lastRunAt ? timeAgo(scanner.lastRunAt) : 'never run'}</span>
      <span className="break-words text-muted">{guardian ? 'Not installed — integration contract ready' : scanner.note}</span>
    </li>
  );
}

function Scanners({ projectId, overview, onRequested }: { projectId: string; overview: QualityOverview; onRequested: () => void }) {
  return (
    <Panel role="region" aria-label="Scanners">
      <PanelHeader title="Scanners"><AuditControl projectId={projectId} overview={overview} onRequested={onRequested} /></PanelHeader>
      {overview.scanners.length === 0
        ? <p className="px-4 py-4 text-[13px] text-muted">No scanners reported.</p>
        : <ul>{overview.scanners.map((scanner) => <ScannerRow key={scanner.id} scanner={scanner} />)}</ul>}
    </Panel>
  );
}

// ------------------------------------------------------------------ findings

export interface FindingFilters { severity: FindingSeverity | ''; source: FindingSource | ''; status: FindingStatus | ''; }
const NO_FILTERS: FindingFilters = { severity: '', source: '', status: '' };

/** Only set filters are sent. */
export function buildFindingQuery(projectId: string, runId: string, filters: FindingFilters, q: string): FindingQuery {
  const query: FindingQuery = { projectId, limit: FINDINGS_LIMIT };
  if (runId) query.runId = runId;
  if (filters.severity) query.severity = filters.severity;
  if (filters.source) query.source = filters.source;
  if (filters.status) query.status = filters.status;
  if (q.trim()) query.q = q.trim();
  return query;
}

function SeverityChips({ counts, selected, onSelect }: { counts: FindingsResponse['counts']; selected: FindingSeverity | ''; onSelect: (severity: FindingSeverity | '') => void }) {
  const visible = FINDING_SEVERITIES.filter((severity) => severity !== 'info' || counts.info > 0 || selected === 'info');
  return (
    <div role="group" aria-label="Severity" className="flex flex-wrap gap-1.5">
      {visible.map((severity) => (
        <button key={severity} type="button" aria-pressed={selected === severity} onClick={() => onSelect(selected === severity ? '' : severity)}
          className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors', SEVERITY_TONE[severity], selected === severity && 'ring-1 ring-brand', selected && selected !== severity && 'opacity-60')}>
          {SEVERITY_LABEL[severity]}{' '}<span className="tabular-nums">{counts[severity]}</span>
        </button>
      ))}
    </div>
  );
}

interface FindingsPanelProps {
  data: FindingsResponse | null;
  error: string | null;
  filters: FindingFilters;
  onFilters: (patch: Partial<FindingFilters>) => void;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string | null;
  onOpen: (finding: Finding) => void;
  onRetry: () => void;
}

function FindingsBody({ data, error, hasFilters, selectedId, onOpen, onRetry }: Pick<FindingsPanelProps, 'data' | 'error' | 'selectedId' | 'onOpen' | 'onRetry'> & { hasFilters: boolean }) {
  if (error && !data) return <ErrorState title="Could not load findings" message={error} onRetry={onRetry} />;
  if (!data) return <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading findings"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-5/6" /><Skeleton className="h-6 w-2/3" /></div>;
  if (data.findings.length === 0) {
    return (
      <EmptyState icon={<ShieldCheck size={22} aria-hidden="true" />} title={hasFilters ? 'No findings match these filters' : 'No findings for this run'}>
        {hasFilters ? 'Clear a filter to see the rest.' : 'Findings appear when the security or code review agents report issues, or after a dependency audit.'}
      </EmptyState>
    );
  }
  return (
    <>
      {data.truncated && <p role="status" className="border-b border-line-soft px-4 py-1.5 text-[12px] text-st-waiting">More findings matched than are shown. Narrow the filters to see the rest.</p>}
      <FindingsTable findings={data.findings} selectedId={selectedId} onOpen={onOpen} />
    </>
  );
}

function FindingsPanel(props: FindingsPanelProps) {
  const { data, error, filters, onFilters, search, onSearch } = props;
  const hasFilters = Boolean(filters.severity || filters.source || filters.status || search.trim());
  const zero = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  return (
    <Panel role="region" aria-label="Findings">
      <PanelHeader title="Findings" />
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
        <SeverityChips counts={data?.counts ?? zero} selected={filters.severity} onSelect={(severity) => onFilters({ severity })} />
        <Select aria-label="Source" className="w-40" value={filters.source} onChange={(e) => onFilters({ source: e.target.value as FindingSource | '' })}>
          <option value="">All sources</option>
          {(Object.keys(SOURCE_LABEL) as FindingSource[]).map((source) => <option key={source} value={source}>{SOURCE_LABEL[source]}</option>)}
        </Select>
        <Select aria-label="Status" className="w-36" value={filters.status} onChange={(e) => onFilters({ status: e.target.value as FindingStatus | '' })}>
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as FindingStatus[]).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
        </Select>
        <div className="relative w-48">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-faint" aria-hidden="true" />
          <Input aria-label="Search findings" className="pl-8" placeholder="Search findings" value={search} onChange={(e) => onSearch(e.target.value)} />
        </div>
      </div>
      {error && data && <p role="alert" className="border-b border-st-failed/30 bg-st-failed/10 px-4 py-1.5 text-[12.5px] text-st-failed">Could not refresh findings: {error}</p>}
      <FindingsBody data={data} error={error} hasFilters={hasFilters} selectedId={props.selectedId} onOpen={props.onOpen} onRetry={props.onRetry} />
    </Panel>
  );
}

// ------------------------------------------------------------------ page

function OverviewBody({ projectId, overview, error, onRetry, onAuditRequested }: { projectId: string; overview: QualityOverview | null; error: string | null; onRetry: () => void; onAuditRequested: () => void }) {
  if (error && !overview) return <ErrorState title="Could not load quality status" message={error} onRetry={onRetry} />;
  if (!overview) return <div className="space-y-3" aria-busy="true" aria-label="Loading quality status"><Skeleton className="h-28 w-full" /><Skeleton className="h-24 w-full" /></div>;
  return (
    <>
      {error && <p role="alert" className="rounded-md border border-st-failed/30 bg-st-failed/10 px-3 py-1.5 text-[12.5px] text-st-failed">Could not refresh quality status: {error}</p>}
      <ReadinessStrip readiness={overview.readiness} />
      <TestRuns rows={overview.testRuns} />
      <Scanners projectId={projectId} overview={overview} onRequested={onAuditRequested} />
    </>
  );
}

export default function Quality() {
  const projectId = useStudio((s) => s.currentProjectId) ?? '';
  const [runId, setRunId] = useState('');
  const [filters, setFilters] = useState<FindingFilters>(NO_FILTERS);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Finding | null>(null);
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);

  // The header project selector drives this page; a new project starts from its current run again.
  useEffect(() => { setRunId(''); setFilters(NO_FILTERS); setSearch(''); setSelected(null); }, [projectId]);

  const overview = useFetched(() => getQuality(projectId, runId || undefined), `${projectId}|${runId}`, Boolean(projectId));
  // Findings follow the run the readiness strip describes; they wait for it so the first request already names the run.
  const effectiveRun = runId || overview.data?.readiness?.runId || '';
  const query = useMemo(() => buildFindingQuery(projectId, effectiveRun, filters, q), [projectId, effectiveRun, filters, q]);
  const findings = useFetched(() => listFindings(query), JSON.stringify(query), Boolean(projectId) && (overview.data !== null || overview.error !== null));
  const { runs, reload: reloadRuns } = useProjectRuns(projectId);

  const reloadAll = useCallback(() => { void overview.reload(); void findings.reload(); }, [overview.reload, findings.reload]);
  useLiveRefresh(projectId, reloadAll, reloadRuns);

  // Keep an open drawer in step with live updates of its finding.
  useEffect(() => {
    const fresh = findings.data?.findings.find((item) => item.id === selected?.id);
    if (fresh && fresh.updatedAt !== selected?.updatedAt) setSelected(fresh);
  }, [findings.data, selected]);

  if (!projectId) {
    return <EmptyState icon={<ShieldCheck size={24} aria-hidden="true" />} title="No project selected">Pick a project in the header to see its release readiness, findings and scanners.</EmptyState>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
        <h1 className="mr-2 text-base font-semibold">QA &amp; Security</h1>
        <Select aria-label="Run" className="w-40" value={runId} onChange={(e) => setRunId(e.target.value)}>
          <option value="">Current run</option>
          {runs.map((run) => <option key={run.id} value={run.id}>Run #{run.number}</option>)}
        </Select>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <OverviewBody projectId={projectId} overview={overview.data} error={overview.error} onRetry={() => void overview.reload()} onAuditRequested={() => void overview.reload()} />
        <FindingsPanel data={findings.data} error={findings.error} filters={filters} onFilters={(patch) => setFilters((current) => ({ ...current, ...patch }))}
          search={search} onSearch={setSearch} selectedId={selected?.id ?? null} onOpen={setSelected} onRetry={() => void findings.reload()} />
      </div>
      {selected && (
        <FindingDrawer finding={selected} onClose={() => setSelected(null)}
          onChanged={(updated) => { if (updated) setSelected(updated); reloadAll(); }} />
      )}
    </div>
  );
}
