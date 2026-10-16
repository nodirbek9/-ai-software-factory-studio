import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import type { AgentSession, SessionTurn } from '@asf/shared';
import { Markdown } from '@/components/Markdown';
import { Button, ErrorState, Skeleton, Textarea } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSessions, type TurnPage } from './sessionsStore';

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Turn({ turn }: { turn: SessionTurn }) {
  if (turn.author === 'system') {
    return <li className="px-2 text-center text-[11.5px] text-faint" data-turn-author="system">{turn.text}</li>;
  }
  const user = turn.author === 'user';
  return (
    <li className={cn('flex flex-col gap-1', user ? 'items-end' : 'items-start')} data-turn-author={turn.author}>
      <div className={cn('max-w-[92%] rounded-lg border px-3 py-2 text-[13px]', user ? 'border-brand/30 bg-brand/10' : 'border-line-soft bg-ink-850')}>
        {user ? <p className="whitespace-pre-wrap break-words">{turn.text}</p> : <Markdown>{turn.text || '(no text)'}</Markdown>}
        {turn.error && <p role="alert" className="mt-1.5 text-[12px] text-st-failed">{turn.error}</p>}
        {turn.outcome && turn.outcome !== 'ok' && !turn.error && <p className="mt-1.5 text-[12px] text-st-waiting">Turn {turn.outcome}</p>}
      </div>
      <span className="px-1 text-[10.5px] text-faint">
        {clock(turn.startedAt)}{turn.modelReported ? ` · ${turn.modelReported}` : ''}
        {turn.filesChanged.length > 0 ? ` · ${turn.filesChanged.length} file(s) changed` : ''}
      </span>
    </li>
  );
}

interface Props {
  session: AgentSession;
  page: TurnPage;
  live: string;
}

export function ChatTab({ session, page, live }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; busy: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const closed = session.status === 'closed';
  const busy = session.status === 'queued' || session.status === 'running';
  const turnCount = page.items.length;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnCount, live.length]);

  const submit = async () => {
    const message = text.trim();
    if (!message || sending || closed) return;
    setSending(true);
    setError(null);
    try {
      await useSessions.getState().sendMessage(session.id, message);
      setText('');
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : String(cause), busy: cause instanceof ApiError && cause.status === 409 });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Transcript" role="log">
        {page.nextBefore !== null && (
          <div className="mb-2 text-center">
            <Button size="sm" variant="ghost" disabled={page.loading} onClick={() => void useSessions.getState().loadTurns(session.id, true)}>
              Load earlier turns
            </Button>
          </div>
        )}
        {!page.loaded && page.loading && <div className="space-y-2" aria-busy="true"><Skeleton className="h-10 w-3/4" /><Skeleton className="ml-auto h-10 w-1/2" /></div>}
        {page.error && <ErrorState title="Could not load the transcript" message={page.error} onRetry={() => void useSessions.getState().loadTurns(session.id)} />}
        {page.loaded && turnCount === 0 && !live && (
          <p className="px-4 py-8 text-center text-[13px] text-muted">
            No messages yet. No agent process exists until you send the first message.
          </p>
        )}
        <ul className="space-y-3">
          {page.items.map((turn) => <Turn key={`${turn.seq}:${turn.id}`} turn={turn} />)}
          {live && (
            <li className="flex flex-col items-start gap-1" data-live-output>
              <div className="max-w-[92%] rounded-lg border border-st-running/30 bg-st-running/5 px-3 py-2">
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] text-text">{live}</pre>
              </div>
              <span className="px-1 text-[10.5px] text-st-running">live output…</span>
            </li>
          )}
        </ul>
      </div>
      <form className="shrink-0 space-y-1.5 border-t border-line-soft p-2.5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {error && (
          <p role="alert" className={cn('rounded-md border px-2.5 py-1.5 text-[12px]', error.busy ? 'border-st-waiting/40 bg-st-waiting/10 text-st-waiting' : 'border-st-failed/40 bg-st-failed/10 text-st-failed')}>
            {error.busy ? `This session is busy: ${error.message}` : error.message}
          </p>
        )}
        <Textarea
          rows={2} value={text} disabled={closed}
          aria-label={`Message to ${session.title}`}
          placeholder={closed ? 'This session is closed.' : busy ? 'The agent is working — wait for the turn to finish or stop it…' : 'Message the agent… (Ctrl+Enter to send)'}
          onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown}
          className="resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-faint">Ctrl+Enter sends · one turn at a time</span>
          <Button type="submit" variant="primary" size="sm" disabled={closed || sending || busy || !text.trim()}>
            <Send size={13} aria-hidden="true" /> {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}
