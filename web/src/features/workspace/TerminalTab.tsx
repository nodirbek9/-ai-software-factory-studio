import { useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import type { AgentSession } from '@asf/shared';
import { Button, EmptyState, ErrorState } from '@/components/ui/primitives';
import { MAX_TERMINALS, closeTerminal, openTerminal, terminalSocketUrl, type TerminalInfo, type TerminalList } from './terminalApi';
import { useLoad } from './useLoad';

/**
 * Owner terminal of an edit session (Phase 3c, D-019): PowerShell in the session's own worktree, opened only by the
 * button below. xterm.js is loaded with this tab, so panels without an open terminal never pay for it.
 */
export default function TerminalTab({ session }: { session: AgentSession }) {
  const { data, error, loading, reload } = useLoad<TerminalList>('/api/v2/terminals');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const mine = data?.terminals.find((t) => t.sessionId === session.id) ?? null;

  const open = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      await openTerminal(session.id, 100, 30);
      reload();
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };

  if (error && !data) return <ErrorState title="Could not load terminals" message={error} onRetry={reload} />;
  if (loading && !data) return <p className="p-3 text-[12px] text-muted" aria-busy="true">Loading terminals…</p>;
  if (mine) return <LiveTerminal terminal={mine} onClosed={reload} />;

  const full = (data?.terminals.length ?? 0) >= MAX_TERMINALS;
  const reason = data?.unavailableReason ?? (full ? `${MAX_TERMINALS} terminals are already open; close one first` : null);
  return (
    <div className="p-3">
      <EmptyState icon={<TerminalIcon size={20} aria-hidden="true" />} title="No terminal open">
        <p className="max-w-md text-center text-[12px] text-muted">
          PowerShell in this session's own worktree ({session.branch ?? 'session branch'}). Secret environment variables are removed;
          it closes after 15 minutes without your input (output alone does not keep it open), and the transcript is kept in the audit log.
        </p>
        <Button size="sm" variant="primary" disabled={opening || Boolean(reason)} title={reason ?? undefined} onClick={() => void open()}>
          {opening ? 'Opening…' : 'Open terminal'}
        </Button>
      </EmptyState>
      {reason && <p className="mt-2 text-center text-[12px] text-muted">{reason}</p>}
      {openError && <p role="alert" className="mt-2 text-center text-[12px] text-st-failed">{openError}</p>}
    </div>
  );
}

function LiveTerminal({ terminal, onClosed }: { terminal: TerminalInfo; onClosed: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined as void;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
      if (disposed || !host.current) return;
      const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12.5, cursorBlink: true, convertEol: false,
        theme: { background: '#0b0f17' } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host.current);
      fit.fit();
      const socket = new WebSocket(terminalSocketUrl(terminal.id));
      const send = (message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
      socket.addEventListener('open', () => {
        setState('open');
        send({ type: 'resize', cols: term.cols, rows: term.rows });
        term.focus();
      });
      socket.addEventListener('message', (event) => term.write(String(event.data)));
      socket.addEventListener('close', () => setState('closed'));
      const input = term.onData((data) => send({ type: 'input', data }));
      const observer = new ResizeObserver(() => {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      });
      observer.observe(host.current);
      cleanup = () => {
        observer.disconnect();
        input.dispose();
        socket.close();
        term.dispose();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [terminal.id]);

  const close = async () => {
    setClosing(true);
    try {
      await closeTerminal(terminal.id);
    } catch {
      // already closed (idle kill, shell exit): the list reload shows the real state
    } finally {
      setClosing(false);
      onClosed();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5 text-[12px] text-muted">
        <span className="min-w-0 truncate" title={terminal.cwd}>
          {state === 'connecting' ? 'Connecting…' : state === 'open' ? 'PowerShell' : 'Disconnected'} · <code className="font-mono">{terminal.cwd}</code>
        </span>
        <Button size="sm" disabled={closing} onClick={() => void close()} aria-label="Close terminal">
          <X size={12} aria-hidden="true" /> Close terminal
        </Button>
      </div>
      {state === 'closed' && (
        <p role="status" className="shrink-0 px-3 py-1 text-[12px] text-st-waiting">
          The terminal connection ended. <button type="button" className="underline" onClick={onClosed}>Refresh</button>
        </p>
      )}
      <div ref={host} aria-label="Terminal" className="min-h-0 flex-1 bg-[#0b0f17] p-1" />
    </div>
  );
}
