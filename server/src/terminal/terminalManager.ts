import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { StudioContext } from '../orchestrator/context.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { isLoopback } from '../config.ts';
import { redact } from '../security/redact.ts';
import { commandEnv } from '../workspace/processRunner.ts';

/**
 * Interactive owner terminals (Phase 3c, D-019/D-021, AGENT_WORKSPACE_SPEC §14): a PowerShell in an edit session's own
 * worktree, opened only by an explicit click, loopback only, at most two at a time, killed after 15 minutes without
 * the owner's input or before the session's worktree goes away. Agents never get a terminal. Opening, closing and the
 * redacted transcript are audit events.
 */
export const MAX_TERMINALS = 2;
/** Viewers per terminal: the panel plus a reload; more would multiply buffered output (V21-S7). */
export const MAX_VIEWERS = 2;
export const IDLE_KILL_MS = 15 * 60_000;
const TRANSCRIPT_MAX = 64 * 1024;
const BACKLOG_MAX = 64 * 1024;
const EXIT_WAIT_MS = 3_000;

export class TerminalError extends ProjectError {}

/** The subset of node-pty the manager uses (tests pass a fake). */
export interface PtyProcess {
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtySpawn = (file: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => PtyProcess;

const defaultSpawn: PtySpawn = (file, args, options) => {
  const pty = createRequire(import.meta.url)('@lydell/node-pty') as { spawn: (f: string, a: string[], o: unknown) => PtyProcess };
  return pty.spawn(file, args, { name: 'xterm-256color', ...options });
};

/** No profile or rc files: they could change directory or load credentials before the first command (V21-S8). */
const SHELL: [string, string[]] = process.platform === 'win32' ? ['powershell.exe', ['-NoLogo', '-NoProfile']] : ['bash', ['--noprofile', '--norc']];

export interface TerminalInfo {
  id: string;
  sessionId: string;
  projectId: string;
  cwd: string;
  openedAt: string;
}

/** A connected client: receives output, and `end` when the terminal finishes. */
export interface TerminalViewer {
  data(chunk: string): void;
  end(reason: string): void;
}

interface Terminal extends TerminalInfo {
  pty: PtyProcess;
  /** Output kept for a client that (re)connects; the newest 64 KB. */
  backlog: string;
  transcript: string;
  viewers: Set<TerminalViewer>;
  idle: NodeJS.Timeout;
  exited: Promise<void>;
  closed: boolean;
}

export interface TerminalSessionPort {
  /** The edit session's own worktree; throws when the session cannot have a terminal (closed, read-only, busy). */
  terminalCwd(sessionId: string): { cwd: string; projectId: string };
}

export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  constructor(private readonly ctx: StudioContext, private readonly sessions: TerminalSessionPort,
    private readonly spawn: PtySpawn = defaultSpawn, private readonly idleMs = IDLE_KILL_MS) {}

  /** Why terminals are unavailable on this server, or null. */
  unavailableReason(): string | null {
    if (!isLoopback(this.ctx.config.host)) return 'Terminals are disabled when the studio is reachable from other computers';
    return null;
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => !t.closed).map(info);
  }

  open(sessionId: string, size: { cols: number; rows: number }): TerminalInfo {
    const reason = this.unavailableReason();
    if (reason) throw new TerminalError(reason, 403);
    if (this.terminals.size >= MAX_TERMINALS) throw new TerminalError(`At most ${MAX_TERMINALS} terminals can be open; close one first`, 409);
    const { cwd, projectId } = this.sessions.terminalCwd(sessionId);
    const env = Object.fromEntries(Object.entries(commandEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const pty = this.spawn(SHELL[0], SHELL[1], { cwd, cols: size.cols, rows: size.rows, env });
    let markExited = (): void => undefined;
    const terminal: Terminal = {
      id: randomUUID(), sessionId, projectId, cwd, openedAt: new Date().toISOString(), pty,
      backlog: '', transcript: '', viewers: new Set(), idle: setTimeout(() => undefined, 0), closed: false,
      exited: new Promise<void>((resolve) => { markExited = resolve; }),
    };
    this.terminals.set(terminal.id, terminal);
    this.touch(terminal);
    pty.onData((data) => {
      // Output does not count as activity: an unattended command must not keep a terminal alive forever (V21-S9).
      terminal.backlog = (terminal.backlog + data).slice(-BACKLOG_MAX);
      if (terminal.transcript.length < TRANSCRIPT_MAX) terminal.transcript += data;
      terminal.viewers.forEach((viewer) => viewer.data(data));
    });
    pty.onExit(() => {
      markExited();
      this.finish(terminal, 'the shell exited');
    });
    this.ctx.events.emit({ projectId, type: 'audit.terminal.opened', level: 'warn', message: `Terminal opened in ${cwd}`,
      data: { terminalId: terminal.id, sessionId, cwd } });
    return info(terminal);
  }

  /** Streams output to a client: the backlog first, then live data. Returns the detach function. */
  attach(terminalId: string, viewer: TerminalViewer): () => void {
    const terminal = this.require(terminalId);
    if (terminal.viewers.size >= MAX_VIEWERS) throw new TerminalError('This terminal is already open in another window', 409);
    if (terminal.backlog) viewer.data(terminal.backlog);
    terminal.viewers.add(viewer);
    return () => terminal.viewers.delete(viewer);
  }

  input(terminalId: string, data: string): void {
    const terminal = this.require(terminalId);
    this.touch(terminal);
    terminal.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.require(terminalId).pty.resize(cols, rows);
  }

  close(terminalId: string): Promise<void> {
    return this.finish(this.require(terminalId), 'closed by the owner');
  }

  /** Kills a session's terminals and waits for the shells to exit (its worktree is about to be removed, V21-S4). */
  async closeForSession(sessionId: string): Promise<void> {
    await Promise.all([...this.terminals.values()].filter((t) => t.sessionId === sessionId)
      .map((terminal) => this.finish(terminal, 'the session worktree is being removed')));
  }

  /** Same for every terminal of a project that is being deleted (V21-S5). */
  async closeForProject(projectId: string): Promise<void> {
    await Promise.all([...this.terminals.values()].filter((t) => t.projectId === projectId)
      .map((terminal) => this.finish(terminal, 'the project is being deleted')));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.terminals.values()].map((terminal) => this.finish(terminal, 'the studio stopped')));
  }

  private require(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.closed) throw new TerminalError('Terminal not found (it was closed)', 404);
    return terminal;
  }

  private touch(terminal: Terminal): void {
    clearTimeout(terminal.idle);
    terminal.idle = setTimeout(() => void this.finish(terminal, `no input for ${Math.round(this.idleMs / 60_000)} minutes`), this.idleMs);
    terminal.idle.unref?.();
  }

  /** Kills the shell, tells the viewers, logs the transcript; resolves when the shell has exited (or after 3 s). */
  private async finish(terminal: Terminal, why: string): Promise<void> {
    if (!terminal.closed) {
      terminal.closed = true;
      clearTimeout(terminal.idle);
      try {
        terminal.pty.kill();
      } catch {
        // already exited
      }
      terminal.viewers.forEach((viewer) => viewer.end(why));
      terminal.viewers.clear();
      const transcript = redact(terminal.transcript.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      this.ctx.events.emit({ projectId: terminal.projectId, type: 'audit.terminal.closed', level: 'warn', message: `Terminal closed: ${why}`,
        data: { terminalId: terminal.id, sessionId: terminal.sessionId, transcript, truncated: terminal.transcript.length >= TRANSCRIPT_MAX } });
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([terminal.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_WAIT_MS); })]);
    clearTimeout(timer);
    // The slot is freed only once the shell is gone, so a new terminal never overlaps a dying one.
    this.terminals.delete(terminal.id);
  }
}

const info = ({ id, sessionId, projectId, cwd, openedAt }: TerminalInfo): TerminalInfo => ({ id, sessionId, projectId, cwd, openedAt });
