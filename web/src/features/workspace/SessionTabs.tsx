import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AgentSession, SessionTurn } from '@asf/shared';
import { Button, EmptyState, ErrorState, Input, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { cn, formatTokens } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { stripAnsi } from './panelActions';
import { useSessions, type TurnPage } from './sessionsStore';
import { useLoad } from './useLoad';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function Loading() {
  return <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-24 w-full" /></div>;
}

// ------------------------------------------------------------------ Activity

export function ActivityTab({ page }: { page: TurnPage }) {
  const rows = page.items.flatMap((turn) => turn.activity.map((line, index) => ({ key: `${turn.seq}:${index}`, line, at: turn.startedAt })));
  if (!page.loaded) return <Loading />;
  if (!rows.length) {
    return <EmptyState title="No tool activity yet">Tool calls such as “Editing src/app.ts” appear here once the agent has run a turn.</EmptyState>;
  }
  return (
    <ul className="h-full space-y-1 overflow-y-auto p-3 text-[12.5px]" aria-label="Agent activity">
      {rows.map((row) => (
        <li key={row.key} className="flex gap-2">
          <time className="shrink-0 tabular-nums text-faint" dateTime={row.at}>{new Date(row.at).toLocaleTimeString([], { hour12: false })}</time>
          <span className="min-w-0 break-words text-text">{row.line}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ Changes (diff)

interface DiffFile { name: string; added: number; removed: number; lines: string[] }

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      current = { name: match ? match[1] : line.slice(11), added: 0, removed: 0, lines: [] };
      files.push(current);
    }
    if (!current) {
      if (!line.trim()) continue;
      current = { name: '(diff)', added: 0, removed: 0, lines: [] };
      files.push(current);
    }
    if (line.startsWith('+') && !line.startsWith('+++')) current.added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed += 1;
    current.lines.push(line);
  }
  return files;
}

function diffText(value: unknown): { text: string; note: string | null } {
  if (typeof value === 'string') return { text: value, note: null };
  if (isObject(value)) {
    const text = typeof value.diff === 'string' ? value.diff : '';
    const note = typeof value.note === 'string' ? value.note : value.truncated === true ? 'The diff was truncated by the server.' : null;
    return { text, note };
  }
  return { text: '', note: null };
}

export function ChangesTab({ session }: { session: AgentSession }) {
  const diff = useLoad<unknown>(`/api/v2/sessions/${session.id}/diff`);
  const parsed = useMemo(() => {
    const { text, note } = diffText(diff.data);
    return { files: parseDiff(text), note };
  }, [diff.data]);
  if (diff.loading && !diff.data) return <Loading />;
  if (diff.error) return <ErrorState title="Could not load the diff" message={diff.error} onRetry={diff.reload} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5 text-[12px] text-muted">
        <span>{parsed.files.length} file(s) changed vs integration</span>
        <Button size="sm" variant="ghost" onClick={diff.reload} aria-label="Refresh diff"><RefreshCw size={12} aria-hidden="true" /> Refresh</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {parsed.note && <p role="status" className="rounded-md border border-st-waiting/30 bg-st-waiting/10 px-2.5 py-1.5 text-[12px] text-st-waiting">{parsed.note}</p>}
        {!parsed.files.length && <EmptyState title="No changes yet">Changes appear after the agent edits files in its worktree.</EmptyState>}
        {parsed.files.map((file) => (
          <details key={file.name} className="rounded-md border border-line-soft bg-ink-950" open={parsed.files.length <= 3}>
            <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12.5px]">
              <span className="font-mono">{file.name}</span>
              <span className="ml-2 text-st-completed">+{file.added}</span> <span className="text-st-failed">−{file.removed}</span>
            </summary>
            <pre className="overflow-x-auto border-t border-line-soft p-2 font-mono text-[11.5px] leading-snug">
              {file.lines.map((line, index) => (
                <span key={index} className={cn('block', line.startsWith('+') && !line.startsWith('+++') && 'bg-st-completed/10 text-st-completed',
                  line.startsWith('-') && !line.startsWith('---') && 'bg-st-failed/10 text-st-failed', line.startsWith('@@') && 'text-brand-2')}>
                  {line || ' '}
                </span>
              ))}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Files (read-only)

function filePaths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : isObject(value) ? (value.files ?? value.entries ?? value.paths) : null;
  if (!Array.isArray(list)) return [];
  const paths: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') paths.push(entry);
    else if (isObject(entry) && typeof (entry.path ?? entry.name) === 'string' && entry.type !== 'dir' && entry.type !== 'directory') {
      paths.push((entry.path ?? entry.name) as string);
    }
  }
  return paths.sort();
}

function FileContent({ sessionId, path }: { sessionId: string; path: string }) {
  const file = useLoad<unknown>(`/api/v2/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`);
  if (file.loading) return <Loading />;
  if (file.error) {
    const blocked = file.status === 403;
    return (
      <p role="alert" className="m-2 rounded-md border border-st-waiting/40 bg-st-waiting/10 px-2.5 py-2 text-[12.5px] text-st-waiting">
        {blocked ? `Protected file — ${file.error}` : file.error}
      </p>
    );
  }
  const content = typeof file.data === 'string' ? file.data : isObject(file.data) && typeof file.data.content === 'string' ? file.data.content : '';
  return <pre aria-label={`Content of ${path}`} className="h-full overflow-auto p-2 font-mono text-[11.5px] leading-snug">{content || '(empty file)'}</pre>;
}

export function FilesTab({ session }: { session: AgentSession }) {
  const list = useLoad<unknown>(`/api/v2/sessions/${session.id}/files`);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const paths = useMemo(() => filePaths(list.data), [list.data]);
  const shown = paths.filter((p) => p.toLowerCase().includes(filter.trim().toLowerCase()));
  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorState title="Could not list files" message={list.error} onRetry={list.reload} />;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-2/5 min-w-[130px] flex-col border-r border-line-soft">
        <div className="p-1.5"><Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" aria-label="Filter files" /></div>
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1" aria-label="Files">
          {!shown.length && <li className="px-3 py-2 text-[12px] text-muted">{paths.length ? 'No file matches.' : 'No files in this worktree.'}</li>}
          {shown.map((path) => (
            <li key={path}>
              <button type="button" onClick={() => setSelected(path)} title={path} aria-current={selected === path || undefined}
                className={cn('block w-full truncate px-3 py-1 text-left font-mono text-[11.5px] hover:bg-ink-800', selected === path ? 'bg-ink-800 text-text' : 'text-muted')}>
                {path}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 flex-1">
        {selected ? <FileContent key={selected} sessionId={session.id} path={selected} /> : <EmptyState title="Select a file">Read-only view of the session working directory.</EmptyState>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Output (run-tests)

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return '';
  for (const key of ['output', 'outputTail', 'text'] as const) if (typeof value[key] === 'string') return value[key] as string;
  return isObject(value.result) ? outputText(value.result) : '';
}

export function OutputTab({ session, page }: { session: AgentSession; page: TurnPage }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSystem: SessionTurn | undefined = [...page.items].reverse().find((turn) => turn.author === 'system');
  const text = result ?? lastSystem?.text ?? '';

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(stripAnsi(outputText(await useSessions.getState().runAction(session.id, 'run-tests'))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5 text-[12px] text-muted">
        <span>Project test command in this session’s working directory</span>
        <Button size="sm" disabled={running || session.status === 'closed'} onClick={() => void run()}>{running ? 'Running…' : 'Run tests'}</Button>
      </div>
      {error && <p role="alert" className="m-2 rounded-md border border-st-failed/40 bg-st-failed/10 px-2.5 py-1.5 text-[12px] text-st-failed">{error}</p>}
      {text
        ? <pre aria-label="Test output" className="min-h-0 flex-1 overflow-auto bg-ink-950 p-3 font-mono text-[11.5px] leading-snug">{stripAnsi(text)}</pre>
        : <EmptyState title="No output yet">Run the project’s test command here; its output appears as plain text.</EmptyState>}
    </div>
  );
}

// ------------------------------------------------------------------ Task

export function TaskTab({ session }: { session: AgentSession }) {
  const task = useStudio((state) => state.snapshot?.tasks.find((item) => item.id === session.taskId));
  if (!task) return <EmptyState title="Task not available">The linked task is not part of the loaded project.</EmptyState>;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 text-[13px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{task.title}</h3>
          <p className="text-[12px] text-muted">{task.key} · {task.role} · {task.kind}</p>
        </div>
        <StatusBadge status={task.status} />
      </div>
      {task.description && <p className="whitespace-pre-wrap text-muted">{task.description}</p>}
      {task.resultSummary && <section><h4 className="text-[12px] font-medium text-muted">Result</h4><p className="whitespace-pre-wrap">{task.resultSummary}</p></section>}
      {task.error && <p role="alert" className="text-st-failed">{task.error}</p>}
      {task.testResult && (
        <section>
          <h4 className="text-[12px] font-medium text-muted">Tests — {task.testResult.passed ? 'passed' : 'failed'}</h4>
          <p className="text-[12px] text-muted">{task.testResult.summary}</p>
        </section>
      )}
      {task.usage && <p className="text-[12px] text-muted">{formatTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens</p>}
      {task.filesChanged.length > 0 && (
        <section>
          <h4 className="text-[12px] font-medium text-muted">Files changed</h4>
          <ul className="font-mono text-[11.5px]">{task.filesChanged.map((file) => <li key={file}>{file}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
