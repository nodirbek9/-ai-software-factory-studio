import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AgentMessage, AgentRole, AgentSession, CreateSessionInput, EffortLevel, EventLevel, FileEntry, Project, SessionTurn, Task, TestResult,
} from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import type { AgentRunOutput } from '../agents/agentExecutor.ts';
import { AgentOutputError, parseFileProtocol } from '../agents/parsers.ts';
import { FILE_PROTOCOL, ROLE_SYSTEM_PROMPTS } from '../agents/prompts.ts';
import type { StoredSession } from '../db/repositories.ts';
import { getSettings, type StudioContext } from '../orchestrator/context.ts';
import type { ProcessSlotRelease } from '../orchestrator/processBudget.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { approvedCommands, filesWithConflictMarkers, integrateBranch, type ConflictResolver } from '../orchestrator/taskRunners.ts';
import { redact } from '../security/redact.ts';
import { isSensitivePath } from '../security/sensitiveFiles.ts';
import { isAllowedCommand, runAllowedCommand } from '../workspace/commandRunner.ts';
import { changedFiles, git } from '../workspace/git.ts';

/** A refused session request; `statusCode` is the HTTP status (the API error handler maps ProjectError). */
export class SessionError extends ProjectError {}

export interface SessionPatchInput {
  title?: string;
  providerId?: string;
  model?: string;
  effort?: EffortLevel;
  allowFallback?: boolean;
  taskId?: string | null;
}

export interface SessionDiff {
  /** Unified diff of the session worktree (committed and uncommitted work, new files included) against the integration branch. */
  diff: string;
  files: string[];
  truncated: boolean;
}

export interface SyncResult {
  /** conflict = the merge was aborted and nothing changed; resolved = the session's agent resolved the conflicts. */
  status: 'up-to-date' | 'merged' | 'resolved' | 'conflict';
  files: string[];
}

export interface OrchestratorPost {
  message: AgentMessage;
  forwarded: { sessionId: string; ok: boolean; error: string | null }[];
}

/**
 * "Message all agents" notes are stored in agent_messages under this pseudo role (the column has no CHECK); V1 always
 * lists messages by a real agent role, so it never shows them.
 */
export const ORCHESTRATOR_ROLE = 'orchestrator' as AgentRole;

const REPLAY_TURNS = 12;
const REPLAY_MAX_CHARS = 24 * 1024;
const REPLAY_SUMMARY_CHARS = 200;
const OUTPUT_FLUSH_MS = 750;
const OUTPUT_EVENT_MAX = 2000;
const MAX_ACTIVITY_LINES = 500;
const MAX_ACTIVITY_LINE = 300;
const MAX_DIFF_CHARS = 300 * 1024;
const MAX_NEW_FILE_DIFF_BYTES = 100 * 1024;
const MAX_TASK_DESCRIPTION = 2000;
const SHUTDOWN_WAIT_MS = 10_000;
/** What the CLIs say when a native session cannot be continued; the turn is replayed instead. */
const NATIVE_RESUME_FAILURE = /already in use|no conversation found/i;

type StopReason = 'stop' | 'shutdown' | null;

interface ActiveTurn {
  controller: AbortController;
  reason: StopReason;
  phase: 'queued' | 'running';
  /** Last queue position published for this turn. */
  position: number | null;
  done: Promise<void>;
}

interface ActiveAction {
  name: string;
  controller: AbortController;
}

const now = (): string => new Date().toISOString();
const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function label(session: StoredSession): string {
  return `${session.title} (session ${session.number})`;
}

function collectActivity(activity: string[], chunk: string): void {
  for (const line of lines(chunk)) activity.push(line.length > MAX_ACTIVITY_LINE ? `${line.slice(0, MAX_ACTIVITY_LINE - 1)}…` : line);
  if (activity.length > MAX_ACTIVITY_LINES) activity.splice(0, activity.length - MAX_ACTIVITY_LINES);
}

function conflictText(files: string[], target: string): string {
  return `The changes of this workspace session conflict with work that reached the integration branch ${target} meanwhile.
That branch has been merged into your working tree and git reports conflicts in these files:
${files.map((f) => `- ${f}`).join('\n')}

Resolve every conflict: open each file, remove all conflict markers (<<<<<<<, =======, >>>>>>>) and produce one version
that keeps the intent of BOTH sides. Do not drop either side's features, endpoints, docs sections or tests unless they
are true duplicates. Change nothing else. When done, reply with a one-paragraph summary of how you resolved each file.`;
}

/** A unified "new file" diff for an untracked file (git diff does not show those). */
function newFileDiff(file: string, content: Buffer): string {
  const header = `diff --git a/${file} b/${file}\nnew file mode 100644`;
  if (content.subarray(0, 8000).includes(0)) return `${header}\nBinary files /dev/null and b/${file} differ`;
  if (content.length > MAX_NEW_FILE_DIFF_BYTES) return `${header}\n(new file, ${content.length} bytes — too large to show)`;
  const text = content.toString('utf8');
  if (!text) return header;
  const body = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return `${header}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join('\n')}${text.endsWith('\n') ? '' : '\n\\ No newline at end of file'}`;
}

/**
 * Turn-based workspace agent sessions (AGENT_WORKSPACE_SPEC.md §4–§8). A session is data only until a message is
 * sent; each turn waits for a ProcessBudget slot, runs one AgentExecutor call with the session's explicit provider and
 * is persisted with its activity, usage and changed files. Edit sessions work in their own worktree and reach the
 * project only through an explicit merge on V1's integrate() path.
 */
export class SessionManager {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly actions = new Map<string, ActiveAction>();
  private readonly unsubscribeBudget: () => void;
  private stopped = false;

  constructor(private readonly ctx: StudioContext) {
    this.unsubscribeBudget = ctx.budget.onChange(() => this.publishQueuePositions());
  }

  // ------------------------------------------------------------------ read

  view(session: StoredSession): AgentSession {
    return {
      id: session.id, projectId: session.projectId, number: session.number, title: session.title, role: session.role,
      providerId: session.providerId, model: session.model, effort: session.effort, allowFallback: session.allowFallback,
      mode: session.mode, cwdKind: session.cwdKind, branch: session.branch, worktreePath: session.worktreePath,
      continuity: session.continuity, taskId: session.taskId, status: session.status,
      queuePosition: session.status === 'queued' ? this.ctx.budget.queuePosition({ kind: 'session', id: session.id }) : null,
      lastError: session.lastError, lastActivityAt: session.lastActivityAt, createdAt: session.createdAt, closedAt: session.closedAt,
    };
  }

  list(projectId: string): AgentSession[] {
    this.project(projectId);
    return this.ctx.repos.sessions.listByProject(projectId).map((s) => this.view(s));
  }

  get(sessionId: string): AgentSession {
    return this.view(this.require(sessionId));
  }

  turns(sessionId: string, options: { before?: number; limit: number }): { turns: SessionTurn[]; nextBefore: number | null } {
    this.require(sessionId);
    const turns = this.ctx.repos.sessions.listTurns(sessionId, options);
    const first = turns[0];
    return { turns, nextBefore: first && turns.length >= options.limit && first.seq > 1 ? first.seq : null };
  }

  // ------------------------------------------------------------------ create / change / close

  async create(projectId: string, input: CreateSessionInput): Promise<AgentSession> {
    const project = this.project(projectId);
    if (!project.integrationPath) throw new SessionError('The project has no integration worktree yet', 409);
    const adapter = this.ctx.registry.get(input.providerId);
    if (!adapter) throw new SessionError(`Unknown provider: ${input.providerId}`);
    if (input.taskId) this.linkableTask(projectId, input.taskId);
    let session = this.ctx.repos.sessions.create({
      projectId, title: input.title, role: input.role, providerId: input.providerId, model: input.model, effort: input.effort,
      allowFallback: false, mode: input.mode, cwdKind: input.mode === 'edit' ? 'own-worktree' : 'integration',
      continuity: adapter.supports?.resume === 'native' ? 'native' : 'replay', taskId: input.taskId ?? null,
    });
    if (input.mode === 'edit') {
      try {
        session = this.ctx.repos.sessions.update(session.id, await this.ctx.workspace.createSessionWorktree(project, session.number));
      } catch (error) {
        const message = errorText(error);
        this.ctx.repos.sessions.update(session.id, { status: 'closed', closedAt: now(), lastError: message });
        throw new SessionError(`Could not create the session worktree: ${message}`, 500);
      }
    }
    this.emit(session, 'session.created', `${label(session)} created (${session.mode}${session.branch ? ` on ${session.branch}` : ''})`,
      { session: this.view(session) });
    return this.view(session);
  }

  /** Rename, link a task, or change provider/model/effort (idle only; that starts a new native session). */
  update(sessionId: string, patch: SessionPatchInput): AgentSession {
    const session = this.require(sessionId);
    if (session.status === 'closed') throw new SessionError('This session is closed', 409);
    const routing = (patch.providerId !== undefined && patch.providerId !== session.providerId)
      || (patch.model !== undefined && patch.model !== session.model) || (patch.effort !== undefined && patch.effort !== session.effort);
    if ((routing || patch.allowFallback !== undefined) && this.isBusy(session)) {
      throw new SessionError('Change the provider, model or effort only while the session is idle', 409);
    }
    if (patch.providerId !== undefined && !this.ctx.registry.get(patch.providerId)) throw new SessionError(`Unknown provider: ${patch.providerId}`);
    if (patch.taskId) this.linkableTask(session.projectId, patch.taskId);
    const updated = this.ctx.repos.sessions.update(sessionId, {
      title: patch.title?.trim() || undefined, providerId: patch.providerId, model: patch.model, effort: patch.effort,
      allowFallback: patch.allowFallback, taskId: patch.taskId,
      ...(routing ? { providerSessionRef: null, continuity: 'replay' as const } : {}),
    });
    this.updated(updated, `${label(updated)} updated${routing ? ` (now ${updated.providerId} · ${updated.model || 'default model'})` : ''}`, 'info');
    return this.view(updated);
  }

  /** Closes the session; an edit session must have merged or discarded its work first (the branch is always kept). */
  async close(sessionId: string): Promise<AgentSession> {
    const session = this.require(sessionId);
    if (session.status === 'closed') return this.view(session);
    return this.withAction(session, 'close', async () => {
      const worktree = this.worktreeOf(session);
      if (session.mode === 'edit' && worktree) {
        const project = this.project(session.projectId);
        const dirty = (await this.uncommittedFiles(session)).length > 0;
        const unmerged = await git(worktree, ['log', '--oneline', `${project.integrationBranch}..HEAD`]);
        if (dirty || unmerged) throw new SessionError('Merge or discard the changes of this session before closing it', 409);
        await this.ctx.workspace.removeWorktree(project, worktree);
      }
      const closed = this.ctx.repos.sessions.update(sessionId, { status: 'closed', closedAt: now(),
        worktreePath: session.mode === 'edit' ? null : session.worktreePath });
      this.emit(closed, 'session.closed', `${label(closed)} closed`, { session: this.view(closed) });
      return this.view(closed);
    });
  }

  // ------------------------------------------------------------------ turns

  /** Queues one turn (409 while the previous one is queued or running). */
  send(sessionId: string, text: string): { session: AgentSession; turn: SessionTurn } {
    const session = this.require(sessionId);
    this.assertCanRun(session);
    const turn = this.ctx.repos.sessions.addTurn({ sessionId, author: 'user', text, finishedAt: now(), outcome: 'ok' });
    this.emit(session, 'session.turn', `${label(session)}: message from the user`, { seq: turn.seq, outcome: turn.outcome, turn }, 'debug');
    return { session: this.startTurn(session, turn), turn };
  }

  /** Aborts the queued or running turn (outcome "stopped"); the session stays usable. */
  stop(sessionId: string): AgentSession {
    const session = this.require(sessionId);
    const entry = this.active.get(sessionId);
    const action = this.actions.get(sessionId);
    if (!entry && !action) {
      if (session.status !== 'queued' && session.status !== 'running') throw new SessionError('Nothing is running in this session', 409);
      const fixed = this.ctx.repos.sessions.update(sessionId, { status: 'stopped' }); // a stale state without a live turn
      this.updated(fixed, `${label(fixed)}: stopped`, 'warn');
      return this.view(fixed);
    }
    if (entry) {
      entry.reason = 'stop';
      entry.controller.abort();
    }
    action?.controller.abort();
    this.emit(session, 'session.stop', `${label(session)}: stop requested`, {}, 'warn');
    return this.view(session);
  }

  /** Stops the running turn if needed, then sends the last user message again. */
  async restart(sessionId: string): Promise<{ session: AgentSession; turn: SessionTurn }> {
    const entry = this.active.get(sessionId);
    if (entry) {
      entry.reason = 'stop';
      entry.controller.abort();
      await entry.done;
    }
    const session = this.require(sessionId);
    const last = this.lastUserTurn(sessionId);
    if (!last) throw new SessionError('This session has no message to send again', 409);
    this.assertCanRun(session);
    this.emit(session, 'session.restart', `${label(session)}: sending the last message again`);
    return { session: this.startTurn(session, last), turn: last };
  }

  // ------------------------------------------------------------------ edit-session actions (§7)

  /** Commits the worktree's current changes as `wip(session-<n>): <first line of the last user message>`. */
  async checkpoint(sessionId: string): Promise<{ commit: string | null; files: string[] }> {
    const session = this.requireEdit(sessionId);
    return this.withAction(session, 'checkpoint', () => this.commitCheckpoint(session));
  }

  /** Merges the integration branch into the session worktree; on conflict either aborts or asks this agent to resolve. */
  async sync(sessionId: string, onConflict: 'abort' | 'resolve' = 'abort'): Promise<SyncResult> {
    const session = this.requireEdit(sessionId);
    const project = this.project(session.projectId);
    return this.withAction(session, 'sync', async (signal) => {
      const worktree = this.worktreeOf(session)!;
      const target = project.integrationBranch!;
      await this.commitCheckpoint(session);
      const before = await git(worktree, ['rev-parse', 'HEAD']);
      let resolved = false;
      try {
        await git(worktree, ['merge', '--no-ff', '-m', `merge ${target} into session-${session.number}`, target]);
      } catch (error) {
        const conflicted = lines(await git(worktree, ['diff', '--name-only', '--diff-filter=U']));
        await this.abortMergeUnless(worktree, conflicted.length > 0 && onConflict === 'resolve');
        if (!conflicted.length) throw new SessionError(`Could not merge ${target} into the session: ${errorText(error)}`, 409);
        if (onConflict !== 'resolve') {
          this.ctx.events.emit({ projectId: session.projectId, role: session.role, type: 'git.conflict', level: 'warn',
            message: `${label(session)}: syncing from ${target} conflicts in ${conflicted.length} file(s); the merge was aborted`,
            data: { files: conflicted, sessionId: session.id } });
          return { status: 'conflict' as const, files: conflicted };
        }
        try {
          await this.conflictResolver(session, project, worktree, signal).resolve(conflicted, target);
        } catch (resolveError) {
          await git(worktree, ['merge', '--abort'], true);
          throw new SessionError(`Resolving the conflicts failed: ${errorText(resolveError)}`, 409);
        }
        resolved = true;
      }
      const files = await changedFiles(worktree, before);
      const status: SyncResult['status'] = resolved ? 'resolved' : files.length ? 'merged' : 'up-to-date';
      this.emit(session, 'session.sync', `${label(session)}: synced from ${target} (${status}, ${files.length} file(s))`, { files, status });
      this.addSystemTurn(session, status === 'up-to-date' ? `Synced from ${target}: already up to date.`
        : `Synced from ${target} (${status}): ${files.length} file(s) changed.${files.length ? `\n${files.slice(0, 50).join('\n')}` : ''}`);
      return { status, files };
    });
  }

  /** Checkpoint, then V1's integrate() path under the integration lock (conflict rounds, leftover-marker check). */
  async merge(sessionId: string): Promise<{ files: string[]; commit: string }> {
    const session = this.requireEdit(sessionId);
    const project = this.project(session.projectId);
    return this.withAction(session, 'merge', async (signal) => {
      const worktree = this.worktreeOf(session)!;
      const branch = session.branch!;
      await this.commitCheckpoint(session);
      const pending = await git(worktree, ['log', '--oneline', `${project.integrationBranch}..HEAD`]);
      if (!pending) throw new SessionError('Nothing to merge: the integration branch already has all work of this session', 409);
      let files: string[];
      try {
        files = await integrateBranch(this.ctx, project, worktree, branch, this.conflictResolver(session, project, worktree, signal));
      } catch (error) {
        if (error instanceof SessionError) throw error;
        throw new SessionError(`Merge into ${project.integrationBranch} failed: ${errorText(error)}`, 409);
      }
      const commit = await git(project.integrationPath!, ['rev-parse', 'HEAD']);
      this.ctx.events.emit({ projectId: project.id, role: session.role, type: 'git.merge',
        message: `Merged ${files.length} file(s) from ${branch} (${label(session)})`, data: { files, sessionId: session.id, branch, commit } });
      this.addSystemTurn(session, `Merged into ${project.integrationBranch} (${commit.slice(0, 8)}): ${files.length} file(s).`
        + `${files.length ? `\n${files.slice(0, 50).join('\n')}` : ''}`);
      return { files, commit };
    });
  }

  /** Removes the worktree; its work is committed to the session branch first, and the branch is never deleted. */
  async discard(sessionId: string): Promise<AgentSession> {
    const session = this.require(sessionId);
    if (session.mode !== 'edit') throw new SessionError('Only edit sessions have a worktree to discard', 409);
    return this.withAction(session, 'discard', async () => {
      const project = this.project(session.projectId);
      if (this.worktreeOf(session)) await this.saveWip(session, 'work kept when the worktree was discarded');
      if (session.worktreePath) await this.ctx.workspace.removeWorktree(project, session.worktreePath);
      const discarded = this.ctx.repos.sessions.update(sessionId, { worktreePath: null, lastActivityAt: now() });
      this.emit(discarded, 'session.discarded', `${label(discarded)}: worktree removed; branch ${discarded.branch} is kept`,
        { branch: discarded.branch, session: this.view(discarded) }, 'warn');
      return this.view(discarded);
    });
  }

  /** Runs the project test command in the session cwd (allowlist/approval rules unchanged); output streams to the panel. */
  async runTests(sessionId: string): Promise<TestResult> {
    const session = this.require(sessionId);
    if (session.status === 'closed') throw new SessionError('This session is closed', 409);
    const project = this.project(session.projectId);
    const command = project.testCommand;
    const approved = approvedCommands(this.ctx, project.id).includes(command);
    if (!isAllowedCommand(command) && !approved) {
      if (!this.ctx.repos.approvals.listByProject(project.id).some((a) => a.kind === 'command' && a.status === 'pending' && a.details.command === command)) {
        const approval = this.ctx.repos.approvals.create({ projectId: project.id, taskId: null, kind: 'command',
          title: `Allow test command "${command}"?`, details: { command, reason: 'not in the built-in allowlist' } });
        this.ctx.events.emit({ projectId: project.id, role: session.role, type: 'approval.updated', level: 'warn', message: approval.title, data: { approval } });
      }
      throw new SessionError(`Test command "${command}" needs approval (see Pending approvals)`, 409);
    }
    return this.withAction(session, 'run tests', async (signal) => {
      const cwd = session.mode === 'edit' ? this.worktreeOf(session) : project.integrationPath;
      if (!cwd) throw new SessionError('The worktree of this session was discarded', 409);
      const output = this.outputStream(session, 'tests');
      this.emit(session, 'session.tests', `${label(session)}: running ${command}`, { command, state: 'started' });
      const run = (): Promise<TestResult> => runAllowedCommand(command, cwd, { signal, approved, onOutput: (chunk) => output.push(chunk),
        timeoutMs: getSettings(this.ctx).taskTimeoutMinutes * 60_000 });
      let result: TestResult;
      try {
        // Read-only sessions share the integration worktree, which merges change; edit sessions own their worktree.
        result = session.mode === 'edit' ? await run() : await this.ctx.integrationLock.run(project.id, run);
      } finally {
        output.flush();
      }
      this.emit(session, 'session.tests', `${label(session)}: ${command} ${result.passed ? 'PASSED' : 'FAILED'} (${result.summary}, exit ${result.exitCode})`,
        { command, state: 'finished', testResult: result }, result.passed ? 'info' : 'error');
      this.addSystemTurn(session, `Tests ${result.passed ? 'PASSED' : 'FAILED'}: \`${command}\` — ${result.summary} (exit ${result.exitCode}, `
        + `${Math.round(result.durationMs / 1000)} s)\n\n${result.outputTail}`, result.passed ? 'ok' : 'error');
      return result;
    });
  }

  /** Session branch (committed + uncommitted work, new files) against the integration branch, at most 300 KB. */
  async diff(sessionId: string): Promise<SessionDiff> {
    const session = this.require(sessionId);
    const worktree = session.mode === 'edit' ? this.worktreeOf(session) : null;
    if (!worktree) return { diff: '', files: [], truncated: false };
    const base = this.project(session.projectId).integrationBranch!;
    let tracked: string;
    try {
      tracked = await git(worktree, ['diff', '--merge-base', base]); // merge base of integration and HEAD → working tree
    } catch {
      tracked = await git(worktree, ['diff', `${base}...HEAD`]); // older git: committed work only
    }
    const parts: string[] = [];
    const files: string[] = [];
    for (const chunk of tracked ? tracked.split(/^(?=diff --git )/m) : []) {
      const file = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk)?.[1]?.trim() ?? '';
      if (!file || isSensitivePath(file)) continue;
      files.push(file);
      parts.push(chunk.replace(/\n+$/, ''));
    }
    const untracked = (await git(worktree, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean).sort();
    for (const file of untracked) {
      if (isSensitivePath(file)) continue;
      try {
        const full = this.ctx.workspace.resolveInside(worktree, file);
        if (!fs.statSync(full).isFile()) continue;
        parts.push(newFileDiff(file, fs.readFileSync(full)));
        files.push(file);
      } catch {
        // unreadable or unsafe path: leave it out of the diff
      }
    }
    const diff = parts.join('\n');
    if (diff.length <= MAX_DIFF_CHARS) return { diff, files, truncated: false };
    return { diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated: it is larger than 300 KB)`, files, truncated: true };
  }

  files(sessionId: string): FileEntry[] {
    return this.ctx.workspace.listFiles(this.cwdOf(this.require(sessionId)));
  }

  /** Same guards as the V1 file endpoint (path checks, sensitive files refused with 403). */
  file(sessionId: string, relativePath: string): { content: string; truncated: boolean; binary: boolean } {
    return this.ctx.workspace.readFile(this.cwdOf(this.require(sessionId)), relativePath);
  }

  // ------------------------------------------------------------------ orchestrator inbox (§8)

  /** Stores a "message all agents" note and forwards it only to the sessions the user ticked. */
  postOrchestratorMessage(projectId: string, text: string, forwardTo: string[] = []): OrchestratorPost {
    const project = this.project(projectId);
    const message = this.ctx.repos.messages.add({ projectId, role: ORCHESTRATOR_ROLE, taskId: null, direction: 'user', content: text });
    const targets = [...new Set(forwardTo)];
    this.ctx.events.emit({ projectId, type: 'orchestrator.message',
      message: `Message to the agents${targets.length ? ` (forwarded to ${targets.length} session(s))` : ''}`, data: { message, forwardTo: targets } });
    const forwarded = targets.map((sessionId) => {
      const session = this.ctx.repos.sessions.get(sessionId);
      if (!session || session.projectId !== projectId) return { sessionId, ok: false, error: 'Session not found in this project' };
      try {
        this.send(sessionId, `Message from the user to the agents of "${project.name}" (sent through the Studio Orchestrator):\n\n${text}`);
        return { sessionId, ok: true, error: null };
      } catch (error) {
        return { sessionId, ok: false, error: errorText(error) };
      }
    });
    return { message, forwarded };
  }

  orchestratorMessages(projectId: string): AgentMessage[] {
    this.project(projectId);
    return this.ctx.repos.messages.list(projectId, ORCHESTRATOR_ROLE, 200);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Crash/restart recovery: unfinished turns become "interrupted", their sessions "failed"; edit work is committed as wip. */
  async recover(): Promise<void> {
    const { sessions } = this.ctx.repos;
    for (const turn of sessions.listUnfinishedTurns()) {
      if (this.active.has(turn.sessionId)) continue;
      sessions.updateTurn(turn.id, { finishedAt: now(), outcome: 'interrupted', error: 'Interrupted by a restart of the studio' });
    }
    for (const session of sessions.listByStatus('queued', 'running')) {
      if (this.active.has(session.id)) continue;
      if (session.mode === 'edit') await this.saveWip(session, 'partial work from a turn interrupted by a restart');
      const failed = sessions.update(session.id, { status: 'failed',
        lastError: 'Interrupted by a restart of the studio; send the message again or press Restart' });
      this.updated(failed, `${label(failed)}: interrupted by a restart`, 'warn');
    }
  }

  /** Aborts running turns and actions (turns end as "interrupted") and waits up to 10 s for them to settle. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribeBudget();
    for (const entry of this.active.values()) {
      entry.reason = 'shutdown';
      entry.controller.abort();
    }
    for (const action of this.actions.values()) action.controller.abort();
    const pending = [...this.active.values()].map((entry) => entry.done);
    if (!pending.length) return;
    let timer: NodeJS.Timeout | null = null;
    await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS); })]);
    if (timer) clearTimeout(timer);
  }

  // ------------------------------------------------------------------ turn execution (§5)

  private startTurn(session: StoredSession, userTurn: SessionTurn): AgentSession {
    const entry: ActiveTurn = { controller: new AbortController(), reason: null, phase: 'queued', position: null, done: Promise.resolve() };
    this.active.set(session.id, entry);
    const queued = this.ctx.repos.sessions.update(session.id, { status: 'queued', lastError: null, lastActivityAt: now() });
    // runTurn asks the budget for a slot synchronously, so the queue position is known right after this call.
    entry.done = this.runTurn(queued, userTurn, entry).catch(() => undefined);
    const current = this.ctx.repos.sessions.get(session.id)!;
    if (current.status === 'queued') {
      entry.position = this.ctx.budget.queuePosition({ kind: 'session', id: session.id });
      this.updated(current, `${label(current)}: queued${entry.position ? ` (#${entry.position})` : ''}`);
    }
    return this.view(current);
  }

  private async runTurn(session: StoredSession, userTurn: SessionTurn, entry: ActiveTurn): Promise<void> {
    const { ctx } = this;
    const signal = entry.controller.signal;
    const output = this.outputStream(session, 'agent');
    const activity: string[] = [];
    let release: ProcessSlotRelease | null = null;
    let agentTurn: SessionTurn | null = null;
    try {
      release = await ctx.budget.acquire({ kind: 'session', id: session.id, projectId: session.projectId, label: session.title }, signal);
      entry.phase = 'running';
      entry.position = null;
      let current = ctx.repos.sessions.update(session.id, { status: 'running', lastActivityAt: now() });
      this.updated(current, `${label(current)}: running`);
      const project = this.project(current.projectId);
      agentTurn = ctx.repos.sessions.addTurn({ sessionId: current.id, author: 'agent', text: '', providerId: current.providerId });
      const { output: result, replayed } = await this.executeTurn(current, project, userTurn, signal, (chunk) => {
        output.push(chunk);
        collectActivity(activity, chunk);
      });
      output.flush();
      const filesChanged = await this.uncommittedFiles(current);
      agentTurn = ctx.repos.sessions.updateTurn(agentTurn.id, { text: result.text.trim() || '(empty reply)', activity,
        providerId: result.providerId, modelReported: result.model, usage: result.usage, filesChanged, finishedAt: now(), outcome: 'ok', error: null });
      // A reference only means something to the session's own provider (not to a fallback that answered instead).
      const ref = result.continuity === 'native' && result.providerId === current.providerId ? result.sessionRef : null;
      current = ctx.repos.sessions.update(current.id, { status: 'idle', lastError: null, lastActivityAt: now(),
        continuity: replayed || !ref ? 'replay' : 'native', providerSessionRef: ref });
      this.turnFinished(current, agentTurn, `${label(current)}: replied`);
    } catch (error) {
      output.flush();
      await this.turnFailed(session, agentTurn, activity, entry, error);
    } finally {
      output.flush();
      release?.();
      this.active.delete(session.id);
    }
  }

  private async turnFailed(session: StoredSession, agentTurn: SessionTurn | null, activity: string[], entry: ActiveTurn, error: unknown): Promise<void> {
    const { sessions } = this.ctx.repos;
    const started = agentTurn !== null;
    const outcome: SessionTurn['outcome'] = entry.reason === 'stop' ? 'stopped' : entry.reason === 'shutdown' ? 'interrupted' : 'error';
    const message = outcome === 'stopped' ? (started ? 'Stopped by the user' : 'Cancelled before it started')
      : outcome === 'interrupted' ? 'Interrupted by a shutdown of the studio' : errorText(error);
    const current = sessions.get(session.id) ?? session;
    if (outcome === 'interrupted' && current.mode === 'edit') await this.saveWip(current, 'partial work from a turn interrupted by a shutdown');
    const filesChanged = await this.uncommittedFiles(current).catch(() => [] as string[]);
    const patch = { activity, filesChanged, finishedAt: now(), outcome, error: message };
    const turn = agentTurn
      ? sessions.updateTurn(agentTurn.id, patch)
      : sessions.addTurn({ sessionId: session.id, author: 'agent', text: '', providerId: current.providerId, ...patch });
    const status = outcome === 'stopped' ? (started ? 'stopped' : 'idle') : 'failed';
    const lastError = outcome === 'stopped' ? null
      : outcome === 'interrupted' ? 'Interrupted by a shutdown of the studio; send the message again or press Restart' : message;
    const updated = sessions.update(session.id, { status, lastError, lastActivityAt: now() });
    this.turnFinished(updated, turn, `${label(updated)}: ${outcome === 'error' ? `failed — ${message}` : outcome}`, outcome === 'error' ? 'error' : 'warn');
  }

  /** One executor call; a native session the CLI cannot resume is replaced by a fresh one with a context replay. */
  private async executeTurn(session: StoredSession, project: Project, userTurn: SessionTurn, signal: AbortSignal,
    onOutput: (chunk: string) => void): Promise<{ output: AgentRunOutput; replayed: boolean }> {
    const attempt = (resumeRef: string | null): Promise<AgentRunOutput> => this.ctx.executor.run({
      project, task: null, role: session.role,
      prompt: (editsFiles, continuity) => this.buildPrompt(session, project, userTurn, editsFiles, continuity?.nativeResume === true),
      cwd: this.cwdOf(session), mode: session.mode, signal, ...this.limits(), fallbackOrder: getSettings(this.ctx).fallbackOrder,
      explicit: this.explicit(session), sessionId: session.id, resumeRef,
      // A first turn (or one after a failed resume) starts a NEW native session: a fresh id never clashes with an old one.
      providerSessionId: resumeRef ? undefined : randomUUID(),
      onOutput,
    });
    const ref = session.providerSessionRef;
    try {
      return { output: await attempt(ref), replayed: false };
    } catch (error) {
      if (!ref || signal.aborted || !NATIVE_RESUME_FAILURE.test(error instanceof Error ? error.message : String(error))) throw error;
      this.emit(session, 'session.continuity', `${label(session)}: the provider could not continue its own session (${errorText(error).slice(0, 200)}); `
        + 'replaying the conversation instead', { continuity: 'replay' }, 'warn');
      return { output: await attempt(null), replayed: true };
    }
  }

  private buildPrompt(session: StoredSession, project: Project, userTurn: SessionTurn, editsFiles: boolean, nativeResume: boolean): string {
    if (nativeResume) return userTurn.text; // the provider keeps the conversation itself
    const parts = [ROLE_SYSTEM_PROMPTS[session.role], this.header(session, project, editsFiles)];
    const history = this.replayHistory(session.id, userTurn.seq);
    if (history) parts.push(`# Conversation so far (context replay of this session's earlier turns)\n${history}`);
    parts.push(`# New message from the user\n${userTurn.text}`);
    return parts.join('\n\n');
  }

  private header(session: StoredSession, project: Project, editsFiles: boolean): string {
    const out = ['# Workspace session',
      `You are the ${AGENT_ROLE_INFO[session.role].name} agent in workspace session "${session.title}" (session ${session.number}) of project "${project.name}".`];
    if (session.mode === 'edit') {
      out.push(`Mode: edit. The current directory is your own git worktree on branch ${session.branch}, created from the integration branch ${project.integrationBranch}.`);
      out.push(editsFiles
        ? 'Edit files in the current directory directly. Do not commit, push or switch branches: the user reviews your changes and merges them.'
        : 'You cannot edit files yourself in this session: show every change you propose (complete file contents) in your reply.');
    } else {
      out.push(`Mode: read-only. The current directory is the project's integration worktree (branch ${project.integrationBranch}). `
        + 'Inspect files, but do not change any file.');
    }
    const task = session.taskId ? this.ctx.repos.tasks.get(session.taskId) : null;
    if (task && task.projectId === project.id) {
      out.push(`Linked task ${task.key} [${task.role}, ${task.status}]: ${task.title}`);
      if (task.description) out.push(task.description.length > MAX_TASK_DESCRIPTION ? `${task.description.slice(0, MAX_TASK_DESCRIPTION)}…` : task.description);
    }
    if (project.testCommand) out.push(`The project test command is: ${project.testCommand}`);
    return out.join('\n');
  }

  /** The last turns before `beforeSeq`, newest kept in full; once 24 KB is reached older turns become one line each. */
  private replayHistory(sessionId: string, beforeSeq: number): string {
    const turns = this.ctx.repos.sessions.listTurns(sessionId, { before: beforeSeq, limit: REPLAY_TURNS })
      .filter((t) => t.text.trim() && (t.author !== 'agent' || t.outcome === 'ok'));
    const picked: string[] = [];
    let size = 0;
    let summarizing = false;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      const who = turn.author === 'user' ? 'User' : turn.author === 'agent' ? 'Agent' : 'Studio';
      const full = `${who}: ${turn.text.trim()}`;
      if (!summarizing && size + full.length <= REPLAY_MAX_CHARS) {
        picked.unshift(full);
        size += full.length + 2;
        continue;
      }
      summarizing = true;
      const line = `${who} (earlier, summarized): ${oneLine(turn.text, REPLAY_SUMMARY_CHARS)}`;
      if (size + line.length > REPLAY_MAX_CHARS) break;
      picked.unshift(line);
      size += line.length + 2;
    }
    return picked.join('\n\n');
  }

  /** `session.output { sessionId, chunk }` events, batched every 750 ms like agent.output. */
  private outputStream(session: StoredSession, source: 'agent' | 'tests'): { push: (chunk: string) => void; flush: () => void } {
    let buffer = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!buffer) return;
      const chunk = buffer.length > OUTPUT_EVENT_MAX ? `…${buffer.slice(-OUTPUT_EVENT_MAX)}` : buffer;
      buffer = '';
      this.ctx.events.emit({ projectId: session.projectId, role: session.role, type: 'session.output', level: 'debug',
        message: `${label(session)} ${source === 'tests' ? 'test' : 'agent'} output`, data: { sessionId: session.id, chunk: redact(chunk), source } });
    };
    return {
      push: (chunk) => {
        buffer += chunk;
        if (!timer) {
          timer = setTimeout(flush, OUTPUT_FLUSH_MS);
          timer.unref?.();
        }
      },
      flush,
    };
  }

  private turnFinished(session: StoredSession, turn: SessionTurn, message: string, level: EventLevel = 'info'): void {
    this.emit(session, 'session.turn', message, { seq: turn.seq, outcome: turn.outcome, turn }, level);
    this.updated(session, message);
  }

  private publishQueuePositions(): void {
    for (const [sessionId, entry] of this.active) {
      if (entry.phase !== 'queued') continue;
      const position = this.ctx.budget.queuePosition({ kind: 'session', id: sessionId });
      if (position === null || position === entry.position) continue;
      entry.position = position;
      const session = this.ctx.repos.sessions.get(sessionId);
      if (session?.status === 'queued') this.updated(session, `${label(session)}: queued (#${position})`);
    }
  }

  // ------------------------------------------------------------------ helpers

  private conflictResolver(session: StoredSession, project: Project, worktreePath: string, signal: AbortSignal): ConflictResolver {
    const key = `session-${session.number}`;
    return {
      key,
      mergeMessage: `merge ${key}: ${session.title}`,
      resolve: async (files, target) => {
        this.ctx.events.emit({ projectId: project.id, role: session.role, type: 'git.conflict', level: 'warn',
          message: `Other work changed the same lines in ${files.length} file(s) (${files.slice(0, 4).join(', ')}); asking ${label(session)} to resolve it`,
          data: { files, sessionId: session.id } });
        const release = await this.ctx.budget.acquire({ kind: 'session', id: session.id, projectId: project.id, label: `${session.title} (conflicts)` }, signal);
        try {
          const output = await this.ctx.executor.run({
            project, task: null, role: session.role, prompt: (edits) => `${conflictText(files, target)}${edits ? '' : `\n\n${FILE_PROTOCOL}`}`,
            cwd: worktreePath, mode: 'edit', signal, ...this.limits(), fallbackOrder: getSettings(this.ctx).fallbackOrder,
            explicit: this.explicit(session), sessionId: session.id, providerSessionId: randomUUID(),
          });
          if (!output.editsFiles) this.ctx.workspace.applyEdits(worktreePath, parseFileProtocol(output.text).files);
        } finally {
          release();
        }
        const unresolved = filesWithConflictMarkers(worktreePath, files);
        if (unresolved.length) throw new AgentOutputError(`Conflict markers are still present in: ${unresolved.join(', ')}`);
        await this.ctx.workspace.commit(worktreePath, `merge: resolve conflicts with ${target} in ${key}`);
        this.ctx.events.emit({ projectId: project.id, role: session.role, type: 'git.conflict',
          message: `Conflicts resolved in ${files.length} file(s) by ${label(session)}`, data: { files, sessionId: session.id } });
      },
    };
  }

  private async commitCheckpoint(session: StoredSession): Promise<{ commit: string | null; files: string[] }> {
    const worktree = this.worktreeOf(session);
    if (!worktree) throw new SessionError('The worktree of this session was discarded', 409);
    const files = await this.uncommittedFiles(session);
    const subject = oneLine(this.lastUserTurn(session.id)?.text.split(/\r?\n/)[0] ?? '', 72) || 'checkpoint';
    const commit = await this.ctx.workspace.commit(worktree, `wip(session-${session.number}): ${subject}`);
    if (commit) {
      this.emit(session, 'session.checkpoint', `${label(session)}: checkpoint ${commit.slice(0, 8)} (${files.length} file(s))`, { commit, files });
    }
    return { commit, files: commit ? files : [] };
  }

  /** Commits whatever is in the worktree (an interrupted turn, a discard); never throws. */
  private async saveWip(session: StoredSession, what: string): Promise<string | null> {
    const worktree = this.worktreeOf(session);
    if (!worktree) return null;
    try {
      if (await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true)) await git(worktree, ['merge', '--abort'], true);
      const commit = await this.ctx.workspace.commit(worktree, `wip(session-${session.number}): ${what}`);
      if (commit) this.emit(session, 'session.partial', `${label(session)}: saved the worktree's changes on ${session.branch} (${commit.slice(0, 8)})`, { commit }, 'warn');
      return commit;
    } catch (error) {
      this.emit(session, 'session.partial', `${label(session)}: could not save the worktree's changes (${errorText(error)}); the worktree is kept at ${worktree}`,
        { worktreePath: worktree }, 'error');
      return null;
    }
  }

  private async abortMergeUnless(worktree: string, keep: boolean): Promise<void> {
    if (!keep) await git(worktree, ['merge', '--abort'], true);
  }

  /** Changed and new files of an edit session's worktree since its last commit (empty for read-only sessions). */
  private async uncommittedFiles(session: StoredSession): Promise<string[]> {
    const worktree = session.mode === 'edit' ? this.worktreeOf(session) : null;
    if (!worktree) return [];
    const tracked = await git(worktree, ['diff', '--name-only', 'HEAD']);
    const untracked = await git(worktree, ['ls-files', '-z', '--others', '--exclude-standard']);
    return [...new Set([...lines(tracked), ...untracked.split('\0').filter(Boolean)])].sort();
  }

  private async withAction<T>(session: StoredSession, name: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) throw new SessionError('The studio is shutting down', 503);
    if (this.active.has(session.id) || session.status === 'queued' || session.status === 'running') {
      throw new SessionError(`Stop the running turn before: ${name}`, 409);
    }
    const busy = this.actions.get(session.id);
    if (busy) throw new SessionError(`This session is busy (${busy.name})`, 409);
    const controller = new AbortController();
    this.actions.set(session.id, { name, controller });
    try {
      return await work(controller.signal);
    } finally {
      this.actions.delete(session.id);
    }
  }

  private assertCanRun(session: StoredSession): void {
    if (this.stopped) throw new SessionError('The studio is shutting down', 503);
    if (session.status === 'closed') throw new SessionError('This session is closed', 409);
    if (this.active.has(session.id) || session.status === 'queued' || session.status === 'running') {
      throw new SessionError('This session is still working on the previous message', 409);
    }
    const action = this.actions.get(session.id);
    if (action) throw new SessionError(`This session is busy (${action.name})`, 409);
    if (session.mode === 'edit' && !this.worktreeOf(session)) {
      throw new SessionError('The worktree of this session was discarded; close it and start a new session', 409);
    }
  }

  private isBusy(session: StoredSession): boolean {
    return this.active.has(session.id) || this.actions.has(session.id) || session.status === 'queued' || session.status === 'running';
  }

  private explicit(session: StoredSession): { providerId: string; model: string; effort: EffortLevel; allowFallback: boolean } {
    return { providerId: session.providerId, model: session.model, effort: session.effort, allowFallback: session.allowFallback };
  }

  private limits(): { timeoutMs: number; idleTimeoutMs: number } {
    const settings = getSettings(this.ctx);
    return { timeoutMs: settings.taskTimeoutMinutes * 60_000, idleTimeoutMs: settings.idleTimeoutMinutes * 60_000 };
  }

  private worktreeOf(session: StoredSession): string | null {
    return session.worktreePath && fs.existsSync(session.worktreePath) ? session.worktreePath : null;
  }

  /** Where the agent works and the Files tab reads: the own worktree of an edit session, else the integration worktree. */
  private cwdOf(session: StoredSession): string {
    const project = this.project(session.projectId);
    return (session.mode === 'edit' ? this.worktreeOf(session) : null) ?? project.integrationPath ?? project.workspacePath;
  }

  private lastUserTurn(sessionId: string): SessionTurn | null {
    const turns = this.ctx.repos.sessions.listTurns(sessionId, { limit: 200 });
    for (let i = turns.length - 1; i >= 0; i -= 1) if (turns[i].author === 'user') return turns[i];
    return null;
  }

  private addSystemTurn(session: StoredSession, text: string, outcome: SessionTurn['outcome'] = 'ok'): void {
    const turn = this.ctx.repos.sessions.addTurn({ sessionId: session.id, author: 'system', text, finishedAt: now(), outcome });
    const updated = this.ctx.repos.sessions.update(session.id, { lastActivityAt: now() });
    this.emit(updated, 'session.turn', `${label(updated)}: ${oneLine(text, 120)}`, { seq: turn.seq, outcome: turn.outcome, turn }, 'debug');
  }

  private linkableTask(projectId: string, taskId: string): Task {
    const task = this.ctx.repos.tasks.get(taskId);
    if (!task || task.projectId !== projectId) throw new SessionError('The linked task does not belong to this project');
    return task;
  }

  private require(sessionId: string): StoredSession {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (!session) throw new SessionError('Session not found', 404);
    return session;
  }

  private requireEdit(sessionId: string): StoredSession {
    const session = this.require(sessionId);
    if (session.mode !== 'edit') throw new SessionError('Only edit sessions have their own worktree', 409);
    if (!this.worktreeOf(session)) throw new SessionError('The worktree of this session was discarded', 409);
    return session;
  }

  private project(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId);
    if (!project) throw new SessionError('Project not found', 404);
    return project;
  }

  private emit(session: StoredSession, type: string, message: string, data: Record<string, unknown> = {}, level: EventLevel = 'info'): void {
    this.ctx.events.emit({ projectId: session.projectId, role: session.role, type, level, message, data: { sessionId: session.id, ...data } });
  }

  private updated(session: StoredSession, message: string, level: EventLevel = 'debug'): void {
    this.emit(session, 'session.updated', message, { session: this.view(session) }, level);
  }
}
