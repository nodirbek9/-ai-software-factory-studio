import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertCircle, ChevronDown, ChevronRight, X } from 'lucide-react';
import type { StudioEvent, TaskDetail, TaskDiff, TaskRow, TaskStatus } from '@asf/shared';
import { Button, ErrorState, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { formatCost, formatMs } from '@/features/workflows/RunPanel';
import { cn, formatTokens } from '@/lib/utils';
import { cancelTask, getTaskDetail, getTaskDiff, retryTask } from './tasksApi';
import { ProviderChip, RoleChip } from './TaskBoard';

/** V1 rules: only failed or cancelled tasks can be retried; only unfinished tasks can be cancelled. */
export const RETRYABLE: TaskStatus[] = ['failed', 'cancelled'];
export const CANCELLABLE: TaskStatus[] = ['pending', 'ready', 'running', 'waiting_approval', 'blocked'];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const timeOf = (iso: string): string => (iso.length >= 19 ? iso.slice(11, 19) : iso);

// ------------------------------------------------------------------ diff

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export function diffLineKind(line: string): DiffLineKind {
  if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(line)) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

const DIFF_TONE: Record<DiffLineKind, string> = {
  add: 'bg-st-completed/10 text-st-completed', del: 'bg-st-failed/10 text-st-failed',
  hunk: 'text-brand-2', meta: 'text-faint', context: 'text-muted',
};

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre aria-label="Git diff" className="max-h-96 overflow-auto rounded-md border border-line-soft bg-ink-950 py-1 font-mono text-[11.5px] leading-[1.45]">
      {diff.split('\n').map((line, index) => {
        const kind = diffLineKind(line);
        return <span key={index} data-diff={kind} className={cn('block whitespace-pre px-2', DIFF_TONE[kind])}>{line || ' '}</span>;
      })}
    </pre>
  );
}

function DiffBody({ taskId }: { taskId: string }) {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    getTaskDiff(taskId).then((result) => { if (!cancelled) setDiff(result); }, (reason: unknown) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [taskId, attempt]);

  if (error) return <ErrorState title="Could not load the diff" message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!diff) return <div className="space-y-1.5" aria-busy="true"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>;
  return (
    <div className="space-y-1.5">
      {diff.base && diff.head && <p className="font-mono text-[11px] text-faint">{diff.base.slice(0, 10)}..{diff.head.slice(0, 10)}</p>}
      {diff.diff ? <DiffView diff={diff.diff} /> : <p className="text-[12.5px] text-muted">No diff available.</p>}
      {diff.truncated && <p className="text-[12px] text-st-waiting">The diff was truncated (300 KB limit).</p>}
      {diff.note && <p className="text-[12px] text-muted">{diff.note}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ sections

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={title} className="border-b border-line-soft">
      <h3>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12px] font-semibold text-muted hover:text-text">
          <Chevron size={13} aria-hidden="true" />{title}
        </button>
      </h3>
      {open && <div className="space-y-1.5 px-4 pb-3 text-[13px]">{children}</div>}
    </section>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-[12.5px] text-muted">{children}</p>;

function Pre({ children, tone }: { children: ReactNode; tone?: string }) {
  return <pre className={cn('max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-soft bg-ink-950 p-2 font-mono text-[11.5px]', tone)}>{children}</pre>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex gap-2 text-[12.5px]"><dt className="w-24 shrink-0 text-faint">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

function TestResultSection({ task }: { task: TaskRow }) {
  const result = task.testResult;
  if (!result) return <Muted>No test run recorded for this task.</Muted>;
  return (
    <>
      <dl className="space-y-0.5">
        <Fact label="Command"><code>{result.command}</code></Fact>
        <Fact label="Exit code">{result.exitCode ?? '—'} <span className={result.passed ? 'text-st-completed' : 'text-st-failed'}>{result.passed ? 'passed' : 'failed'}</span></Fact>
        <Fact label="Duration">{formatMs(result.durationMs)}</Fact>
        <Fact label="Summary">{result.summary || '—'}</Fact>
      </dl>
      {result.outputTail && <Pre>{result.outputTail}</Pre>}
    </>
  );
}

function UsageSection({ task }: { task: TaskRow }) {
  const usage = task.usage;
  if (!usage) return <Muted>Usage not reported by the provider.</Muted>;
  return (
    <dl className="space-y-0.5">
      <Fact label="Input tokens">{formatTokens(usage.inputTokens)}</Fact>
      <Fact label="Output tokens">{formatTokens(usage.outputTokens)}</Fact>
      {usage.reasoningTokens !== undefined && <Fact label="Reasoning">{formatTokens(usage.reasoningTokens)}</Fact>}
      <Fact label="Cost">{formatCost(usage.costUsd)}</Fact>
    </dl>
  );
}

const LEVEL_TONE: Record<StudioEvent['level'], string> = { debug: 'text-faint', info: 'text-muted', warn: 'text-st-waiting', error: 'text-st-failed' };

function EventsSection({ events }: { events: StudioEvent[] }) {
  if (events.length === 0) return <Muted>No events recorded for this task.</Muted>;
  return (
    <ol aria-label="Task events" className="max-h-64 overflow-auto font-mono text-[11.5px]">
      {events.map((event) => (
        <li key={event.id} className="flex gap-2 py-0.5">
          <time className="shrink-0 text-faint" dateTime={event.createdAt}>{timeOf(event.createdAt)}</time>
          <span className="w-24 shrink-0 truncate text-faint" title={event.type}>{event.type}</span>
          <span className={cn('min-w-0 flex-1 break-words', LEVEL_TONE[event.level])}>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

function DetailSections({ detail }: { detail: TaskDetail }) {
  const { task } = detail;
  return (
    <div>
      <Section title="Description">
        {task.description ? <p className="whitespace-pre-wrap break-words">{task.description}</p> : <Muted>No description.</Muted>}
      </Section>
      <Section title="Result summary">
        {task.error && <p role="alert" className="whitespace-pre-wrap break-words text-st-failed">{task.error}</p>}
        {task.resultSummary ? <p className="whitespace-pre-wrap break-words">{task.resultSummary}</p> : !task.error && <Muted>No result yet.</Muted>}
      </Section>
      <Section title="Test result"><TestResultSection task={task} /></Section>
      <Section title="Review text">
        {detail.reviewText ? <Pre>{detail.reviewText}</Pre> : <Muted>No review text stored for this task.</Muted>}
      </Section>
      <Section title="Files changed">
        {task.filesChanged.length === 0 ? <Muted>No files changed.</Muted> : (
          <ul className="space-y-0.5 font-mono text-[12px]">{task.filesChanged.map((file) => <li key={file} className="break-all">{file}</li>)}</ul>
        )}
      </Section>
      <Section title="Git diff" defaultOpen={false}><DiffBody taskId={task.id} /></Section>
      <Section title="Usage"><UsageSection task={task} /></Section>
      <Section title="Fix rounds">
        {detail.fixRounds ? <p className="tabular-nums">{detail.fixRounds.used} / {detail.fixRounds.max} used</p> : <Muted>Not a verification task.</Muted>}
      </Section>
      <Section title="Events"><EventsSection events={detail.events} /></Section>
    </div>
  );
}

// ------------------------------------------------------------------ drawer

export interface TaskDrawerProps {
  taskId: string;
  /** Changes whenever the task list was re-fetched, so the open drawer follows live updates. */
  refreshKey: number;
  onClose: () => void;
  /** Called after a Retry/Cancel succeeded so the board can re-fetch. */
  onChanged: () => void;
}

function useTaskDetail(taskId: string, refreshKey: number) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const result = await getTaskDetail(taskId);
      if (id === seq.current) { setDetail(result); setError(null); }
    } catch (reason) {
      if (id === seq.current) setError(message(reason));
    }
  }, [taskId]);

  useEffect(() => { setDetail(null); setError(null); }, [taskId]);
  useEffect(() => { void load(); return () => { seq.current += 1; }; }, [load, refreshKey]);
  return { detail, error, reload: load };
}

function Actions({ task, onChanged, reload }: { task: TaskRow; onChanged: () => void; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const canRetry = RETRYABLE.includes(task.status);
  const canCancel = CANCELLABLE.includes(task.status);

  const run = async (verb: 'Retry' | 'Cancel', action: (id: string) => Promise<void>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setActionError(null);
    try {
      await action(task.id);
      await reload();
      onChanged();
    } catch (reason) {
      setActionError(`${verb} failed: ${message(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(canRetry || canCancel) && (
        <div className="flex gap-2 px-4 pb-3">
          {canRetry && <Button size="sm" disabled={busy} onClick={() => void run('Retry', retryTask, `Retry "${task.title}"? It runs again from its last checkpoint.`)}>Retry</Button>}
          {canCancel && <Button size="sm" variant="danger" disabled={busy} onClick={() => void run('Cancel', cancelTask, `Cancel "${task.title}"? A running agent is stopped.`)}>Cancel task</Button>}
        </div>
      )}
      {actionError && (
        <div role="alert" className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-st-failed/30 bg-st-failed/10 px-3 py-2 text-[12.5px] text-st-failed">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{actionError}
        </div>
      )}
    </>
  );
}

function DrawerHeader({ task }: { task: TaskRow | null }) {
  return (
    <div className="space-y-2 px-4 pb-3 pt-4">
      <div className="flex items-start justify-between gap-3">
        <DialogPrimitive.Title className="text-[15px] font-semibold leading-snug">{task?.title ?? 'Task details'}</DialogPrimitive.Title>
        <DialogPrimitive.Close className="rounded-md p-1 text-muted hover:bg-ink-800 hover:text-text" aria-label="Close"><X size={16} /></DialogPrimitive.Close>
      </div>
      {task && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <StatusBadge status={task.status} />
          <RoleChip role={task.role} />
          <ProviderChip providerId={task.providerId} model={task.model} />
          <span>{task.projectName}</span>
          {task.runNumber !== null && <span>· run #{task.runNumber}</span>}
          <code className="text-faint">{task.key}</code>
        </div>
      )}
    </div>
  );
}

export function TaskDrawer({ taskId, refreshKey, onClose, onChanged }: TaskDrawerProps) {
  const { detail, error, reload } = useTaskDetail(taskId, refreshKey);
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink-950/50" />
        <DialogPrimitive.Content aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col overflow-y-auto border-l border-line bg-ink-900 shadow-2xl shadow-black/40">
          <DrawerHeader task={detail?.task ?? null} />
          {detail && <Actions key={detail.task.id} task={detail.task} onChanged={onChanged} reload={reload} />}
          {!detail && !error && <div className="space-y-2 p-4" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-24 w-full" /></div>}
          {!detail && error && <ErrorState title="Could not load the task" message={error} onRetry={() => void reload()} />}
          {detail && <DetailSections key={detail.task.id} detail={detail} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
