import fs from 'node:fs';
import type { Project, ProjectStatus, Run, RunStatus, Task, TaskStatus, TestResult } from '@asf/shared';
import type { Db } from '../db/database.ts';
import { dependantsOf } from '../domain/taskGraph.ts';
import { assertTransition } from '../domain/taskStateMachine.ts';
import { NoProviderError } from '../providers/registry.ts';
import { ProviderError } from '../providers/types.ts';
import { redact } from '../security/redact.ts';
import { emitProject, emitTask, getSettings, type StudioContext } from './context.ts';
import { insertFixTask, maxFixRoundsFor } from './fixLoop.ts';
import type { ProcessSlotRelease } from './processBudget.ts';
import { partialBranchOf, PermanentTaskError, savePartialWork, TASK_RUNNERS, VerificationFailedError } from './taskRunners.ts';

type StopReason = 'cancel' | 'shutdown' | null;

const ACTIVE_PROJECT_STATUSES: ReadonlySet<ProjectStatus> = new Set(['planning', 'running', 'awaiting_approval']);
const FINISHED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'completed_with_failures', 'failed', 'cancelled']);
const ERROR_SUMMARY_MAX = 300;
const now = (): string => new Date().toISOString();

// Dependency rules with the workflow failure strategy (WORKFLOW_ENGINE_SPEC.md §8): a failed task whose node says
// onFailure 'continue' counts as done for its dependants; with the default 'stop' its dependants are blocked (V1).

/** A failed task that lets its dependants run anyway. */
function continuedFailure(task: Task | undefined): boolean {
  return task?.status === 'failed' && task.options.onFailure === 'continue';
}

/** Every dependency is completed (or failed with onFailure 'continue'). */
function dependenciesMet(task: Task, byKey: Map<string, Task>): boolean {
  return task.dependsOn.every((key) => {
    const dependency = byKey.get(key);
    return dependency?.status === 'completed' || continuedFailure(dependency);
  });
}

/** A dependency failed, was blocked or cancelled (failures with onFailure 'continue' do not count). */
function dependencyFailed(task: Task, byKey: Map<string, Task>): boolean {
  return task.dependsOn.some((key) => {
    const dependency = byKey.get(key);
    if (continuedFailure(dependency)) return false;
    return dependency?.status === 'failed' || dependency?.status === 'blocked' || dependency?.status === 'cancelled';
  });
}

/** First failed task's error of a run, for the run list (≤ 300 chars). */
function errorSummaryOf(tasks: Task[]): string | null {
  const failed = tasks.find((t) => t.status === 'failed');
  if (!failed) return null;
  return `${failed.key}: ${failed.error ?? 'failed'}`.slice(0, ERROR_SUMMARY_MAX);
}

/** Dependency-aware scheduler: promotes, dispatches, retries and recovers tasks. All state lives in SQLite. */
export class TaskScheduler {
  private readonly active = new Map<string, { controller: AbortController; projectId: string; reason: StopReason }>();
  private stopped = false;

  constructor(private readonly ctx: StudioContext, private readonly db: Db) {}

  get runningCount(): number {
    return this.active.size;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  hasActiveTasks(projectId: string): boolean {
    return [...this.active.values()].some((entry) => entry.projectId === projectId);
  }

  transition(task: Task, to: TaskStatus, patch: Parameters<StudioContext['repos']['tasks']['update']>[1] = {}, message?: string,
    level: 'info' | 'warn' | 'error' = 'info'): Task {
    assertTransition(task.status, to);
    const updated = this.ctx.repos.tasks.update(task.id, { ...patch, status: to });
    emitTask(this.ctx, updated, message ?? `${task.title}: ${task.status} → ${to}`, level);
    return updated;
  }

  /** The run the project's graph is evaluated on: its active run, else its latest run. */
  currentRun(projectId: string): Run | null {
    return this.ctx.repos.runs.activeForProject(projectId) ?? this.ctx.repos.runs.latestForProject(projectId);
  }

  /** Sets the project status; the current run mirrors it (P4-4), or takes `runStatus` when that differs (completed_with_failures). */
  setProjectStatus(project: Project, status: ProjectStatus, message?: string, runStatus?: RunStatus): Project {
    let updated = project;
    if (project.status !== status) {
      updated = this.ctx.repos.projects.update(project.id, { status });
      emitProject(this.ctx, updated, message ?? `Project ${status.replace('_', ' ')}`);
    }
    if (status !== 'draft') this.syncRun(this.currentRun(project.id), runStatus ?? status);
    return updated;
  }

  /** Writes the run status; a finished run records finishedAt and its first task error. Emits 'run.updated' on a change. */
  private syncRun(run: Run | null, status: RunStatus): void {
    if (!run || run.status === status) return;
    // A completed run stays completed when the project is cancelled or fails later; only a retry (running) reopens it.
    if ((run.status === 'completed' || run.status === 'completed_with_failures') && FINISHED_RUN_STATUSES.has(status)) return;
    const finished = FINISHED_RUN_STATUSES.has(status);
    const updated = this.ctx.repos.runs.update(run.id, {
      status,
      finishedAt: finished ? now() : null,
      errorSummary: finished ? errorSummaryOf(this.ctx.repos.tasks.listByRun(run.id)) : null,
    });
    const level = status === 'failed' ? 'error' : status === 'cancelled' || status === 'completed_with_failures' ? 'warn' : 'info';
    this.ctx.events.emit({ projectId: run.projectId, type: 'run.updated', level,
      message: `Run #${updated.number}: ${status.replaceAll('_', ' ')}`, data: { run: updated } });
  }

  /** Re-queues work interrupted by a crash or restart, then resumes active projects. */
  async recover(): Promise<void> {
    for (const task of this.ctx.repos.tasks.listByStatus('running')) {
      const project = this.ctx.repos.projects.get(task.projectId);
      if (!project) continue;
      if (task.checkpoint === 'merged' && task.kind === 'implement') {
        this.transition(task, 'completed', { finishedAt: now(), resultSummary: task.resultSummary ?? 'Recovered after restart: merge was already verified.' },
          `${task.title}: recovered from checkpoint "merged"`);
        continue;
      }
      let kept = false;
      if (task.worktreePath && task.branch && fs.existsSync(task.worktreePath)) {
        kept = !(await savePartialWork(this.ctx, task, task.worktreePath, task.branch, partialBranchOf(this.ctx, task.id)));
      }
      if (task.worktreePath && !kept) await this.ctx.workspace.removeWorktree(project, task.worktreePath).catch(() => undefined);
      this.transition(task, 'ready', { checkpoint: 'none', worktreePath: null, error: 'Interrupted by a restart; re-queued from checkpoint.' },
        `${task.title}: interrupted at checkpoint "${task.checkpoint}", re-queued`, 'warn');
    }
    this.tickAll();
  }

  tickAll(): void {
    for (const project of this.ctx.repos.projects.list()) {
      if (ACTIVE_PROJECT_STATUSES.has(project.status)) this.tick(project.id);
    }
  }

  /** Synchronous graph evaluation (atomic on the event loop) followed by asynchronous dispatch. */
  tick(projectId: string): void {
    if (this.stopped) return;
    let project = this.ctx.repos.projects.get(projectId);
    if (!project || !ACTIVE_PROJECT_STATUSES.has(project.status)) return;
    const run = this.currentRun(projectId);
    if (!run) return;
    let tasks = this.demoteUnmet(this.promote(this.ctx.repos.tasks.listByRun(run.id)));
    for (const gate of tasks.filter((t) => t.kind === 'gate' && t.status === 'ready')) this.openGate(project, gate);
    tasks = this.ctx.repos.tasks.listByRun(run.id);

    const limit = getSettings(this.ctx).maxParallelTasks;
    for (const task of tasks.filter((t) => t.status === 'ready' && t.kind !== 'gate')) {
      if (this.active.size >= limit) break;
      this.start(project, task);
    }
    project = this.ctx.repos.projects.get(projectId)!;
    tasks = this.ctx.repos.tasks.listByRun(run.id);
    const next = this.deriveStatus(project, tasks);
    if (next && next !== 'draft') {
      this.setProjectStatus(project, next, undefined, next === 'completed' && tasks.some(continuedFailure) ? 'completed_with_failures' : next);
    }
  }

  private promote(initial: Task[]): Task[] {
    let tasks = initial;
    let changed = true;
    while (changed) {
      changed = false;
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      for (const task of tasks.filter((t) => t.status === 'pending')) {
        if (dependencyFailed(task, byKey)) {
          this.transition(task, 'blocked', {}, `${task.title}: blocked (a dependency failed)`, 'warn');
          changed = true;
        } else if (dependenciesMet(task, byKey)) {
          this.transition(task, 'ready', {}, `${task.title}: ready`);
          changed = true;
        }
      }
      if (changed) tasks = this.ctx.repos.tasks.listByRun(initial[0]?.runId ?? '');
    }
    return tasks;
  }

  /** Dispatch guard: a "ready" task whose dependencies are not all completed goes back to "pending" instead of running. */
  private demoteUnmet(tasks: Task[]): Task[] {
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const unmet = tasks.filter((t) => t.status === 'ready' && !dependenciesMet(t, byKey));
    if (!unmet.length) return tasks;
    for (const task of unmet) this.transition(task, 'pending', {}, `${task.title}: waiting for its dependencies`, 'warn');
    return this.promote(this.ctx.repos.tasks.listByRun(tasks[0].runId));
  }

  private openGate(project: Project, gate: Task): void {
    this.transition(gate, 'waiting_approval', { startedAt: now() }, 'Plan is ready for your approval');
    if (this.ctx.repos.approvals.pendingForTask(gate.id)) return;
    const planned = this.ctx.repos.tasks.listByRun(gate.runId).filter((t) => !['plan', 'architecture', 'gate'].includes(t.kind));
    const approval = this.ctx.repos.approvals.create({
      projectId: project.id, taskId: gate.id, kind: 'plan', title: `Approve the implementation plan for "${project.name}"`,
      details: { tasks: planned.map((t) => ({ key: t.key, title: t.title, role: t.role, dependsOn: t.dependsOn })) },
    });
    this.ctx.events.emit({ projectId: project.id, taskId: gate.id, role: 'pm', type: 'approval.updated', level: 'warn',
      message: approval.title, data: { approval } });
  }

  private deriveStatus(project: Project, tasks: Task[]): ProjectStatus | null {
    if (!tasks.length) return null;
    const has = (status: TaskStatus): boolean => tasks.some((t) => t.status === status);
    const planningDone = tasks.filter((t) => t.kind === 'plan' || t.kind === 'architecture').every((t) => t.status === 'completed');
    if (tasks.every((t) => t.status === 'completed' || continuedFailure(t))) return 'completed';
    if (has('running') || has('ready')) return planningDone ? 'running' : 'planning';
    if (has('waiting_approval')) return 'awaiting_approval';
    if (has('pending')) return project.status;
    if (!has('failed') && !has('blocked')) return 'cancelled';
    return 'failed';
  }

  private start(project: Project, task: Task): void {
    const controller = new AbortController();
    this.active.set(task.id, { controller, projectId: project.id, reason: null });
    const running = this.transition(task, 'running', {
      attempt: task.attempt + 1, startedAt: now(), finishedAt: null, error: null, checkpoint: 'none', testResult: null,
    }, `${task.title}: started (attempt ${task.attempt + 1}/${task.maxAttempts})`);
    void this.execute(project.id, running, controller.signal);
  }

  /** Waits for a ProcessBudget slot; an abort while queued rejects like any other abort, so fail() applies cancel/shutdown. */
  private acquireSlot(project: Project, task: Task, signal: AbortSignal): Promise<ProcessSlotRelease> {
    const owner = { kind: 'task' as const, id: task.id, projectId: project.id, label: task.title };
    const pending = this.ctx.budget.acquire(owner, signal);
    const position = this.ctx.budget.queuePosition(owner);
    if (position !== null) {
      this.ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'task.waiting_slot', level: 'info',
        message: `${task.title}: waiting for a free agent process slot (position ${position})`,
        data: { position, limit: this.ctx.budget.limit } });
    }
    return pending;
  }

  private async execute(projectId: string, task: Task, signal: AbortSignal): Promise<void> {
    let release: ProcessSlotRelease | null = null;
    try {
      const project = this.ctx.repos.projects.get(projectId)!;
      if (task.kind === 'gate') throw new PermanentTaskError('Gate tasks are completed by approvals');
      if (task.kind === 'plan' && this.planExpanded(task)) {
        this.complete(task, { summary: 'Plan was already expanded before an interruption.' });
        return;
      }
      // A notification starts no process, so it does not wait for an agent process slot.
      if (task.kind !== 'notify') release = await this.acquireSlot(project, task, signal);
      const outcome = await TASK_RUNNERS[task.kind]({ ctx: this.ctx, project, task, signal, db: this.db });
      this.complete(task, outcome);
    } catch (error) {
      this.fail(task, error as Error);
    } finally {
      release?.();
      this.active.delete(task.id);
      if (!this.stopped) setImmediate(() => this.tickAll());
    }
  }

  /** True when the PM's tasks of this plan task's run already exist (the run was interrupted after the expansion). */
  private planExpanded(plan: Task): boolean {
    return dependantsOf(plan.key, this.ctx.repos.tasks.listByRun(plan.runId)).some((t) => t.kind === 'implement' || t.kind === 'test');
  }

  private complete(task: Task, outcome: { summary: string; filesChanged?: string[]; testResult?: TestResult | null }): void {
    const latest = this.ctx.repos.tasks.get(task.id)!;
    const keepReview = latest.kind === 'security' || latest.kind === 'review';
    this.transition(latest, 'completed', {
      finishedAt: now(),
      resultSummary: keepReview ? latest.resultSummary : outcome.summary,
      filesChanged: outcome.filesChanged ?? latest.filesChanged,
      testResult: outcome.testResult ?? latest.testResult,
      usage: this.ctx.repos.usage.totalsForTask(task.id),
    }, `${task.title}: completed`);
    this.ctx.repos.messages.add({ projectId: task.projectId, role: task.role, taskId: task.id, direction: 'agent',
      content: `✔ ${task.title}\n\n${outcome.summary}`.slice(0, 8000) });
    this.ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'agent.message', message: `Completed: ${task.title}` });
  }

  private fail(task: Task, error: Error): void {
    const entry = this.active.get(task.id);
    const latest = this.ctx.repos.tasks.get(task.id)!;
    const message = redact(error.message || String(error)).slice(0, 4000);
    const testResult = (error as Error & { testResult?: TestResult }).testResult ?? latest.testResult;
    const base = { finishedAt: now(), error: message, testResult, usage: this.ctx.repos.usage.totalsForTask(task.id), worktreePath: null };
    if (entry?.reason === 'cancel') {
      this.transition(latest, 'cancelled', { ...base, error: 'Cancelled by user' }, `${task.title}: cancelled`, 'warn');
      return;
    }
    if (entry?.reason === 'shutdown') {
      this.transition(latest, 'ready', { ...base, checkpoint: 'none', error: 'Interrupted by shutdown' }, `${task.title}: interrupted by shutdown`, 'warn');
      return;
    }
    const permanent = error instanceof PermanentTaskError || error instanceof NoProviderError
      || (error instanceof ProviderError && !error.retryable) || (error instanceof VerificationFailedError && !error.retryable);
    const failed = this.transition(latest, 'failed', base, `${task.title}: failed — ${message}`, 'error');
    this.ctx.repos.messages.add({ projectId: task.projectId, role: task.role, taskId: task.id, direction: 'agent',
      content: `✖ ${task.title} failed (attempt ${latest.attempt}/${latest.maxAttempts}):\n${message}` });
    if (error instanceof VerificationFailedError && this.startFixRound(failed, error)) return;
    if (!permanent && latest.attempt < latest.maxAttempts) {
      this.transition(failed, 'ready', { checkpoint: 'none' }, `${task.title}: retrying (attempt ${latest.attempt + 1}/${latest.maxAttempts})`, 'warn');
    }
  }

  /** Fix loop: red tests or a FAIL verdict get a Backend fix task inserted before the verification, which then re-runs. */
  private startFixRound(failed: Task, failure: VerificationFailedError): boolean {
    const round = insertFixTask(this.ctx, this.db, failed, failure.source, redact(failure.findings));
    if (!round) {
      const maxFixRounds = maxFixRoundsFor(this.ctx, failed);
      if (maxFixRounds > 0) {
        this.ctx.events.emit({ projectId: failed.projectId, taskId: failed.id, role: failed.role, type: 'task.fix_exhausted', level: 'warn',
          message: `${failed.title}: all ${maxFixRounds} fix round(s) used — no automatic fix`, data: null });
      }
      return false;
    }
    for (const task of round.shifted) {
      this.ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'task.updated', level: 'debug',
        message: `${task.title}: reordered`, data: { task } });
    }
    emitTask(this.ctx, round.fix, `Fix round ${round.round} planned: ${round.fix.title}`, 'warn');
    emitTask(this.ctx, round.requeued, `${failed.title}: will run again after ${round.fix.key}`, 'warn');
    this.ctx.repos.messages.add({ projectId: failed.projectId, role: 'backend', taskId: round.fix.id, direction: 'system',
      content: `Fix round ${round.round}: ${failed.title} failed, so ${round.fix.key} was assigned to the Backend agent.` });
    return true;
  }

  cancelTask(taskId: string): Task {
    const task = this.ctx.repos.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    const entry = this.active.get(taskId);
    if (entry) {
      entry.reason = 'cancel';
      entry.controller.abort();
      return task;
    }
    const cancelled = this.transition(task, 'cancelled', { finishedAt: now(), error: 'Cancelled by user' }, `${task.title}: cancelled`, 'warn');
    this.tick(task.projectId);
    return cancelled;
  }

  retryTask(taskId: string): Task {
    const task = this.ctx.repos.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'failed' && task.status !== 'cancelled') throw new Error(`Only failed or cancelled tasks can be retried (status: ${task.status})`);
    const run = this.currentRun(task.projectId);
    if (run && run.id !== task.runId) throw new Error('Only tasks of the project\'s current run can be retried');
    const all = this.ctx.repos.tasks.listByRun(task.runId);
    // A retried task whose dependencies are not completed waits in "pending" (promotion decides), never jumps the queue.
    const target: TaskStatus = dependenciesMet(task, new Map(all.map((t) => [t.key, t]))) ? 'ready' : 'pending';
    const retried = this.transition(task, target, { maxAttempts: Math.max(task.maxAttempts, task.attempt + 1), error: null, checkpoint: 'none' },
      `${task.title}: manual retry${target === 'pending' ? ' (waits for its dependencies)' : ''}`);
    for (const dependant of dependantsOf(task.key, all).filter((t) => t.status === 'blocked')) {
      this.transition(dependant, 'pending', {}, `${dependant.title}: unblocked`);
    }
    const project = this.ctx.repos.projects.get(task.projectId)!;
    // A run that ended with tolerated failures (project "completed") reopens too, so the retried task can run.
    const reopen = project.status === 'failed' || project.status === 'cancelled' || run?.status === 'completed_with_failures';
    if (reopen) this.setProjectStatus(project, 'running', 'Project resumed after retry');
    this.tick(task.projectId);
    return retried;
  }

  pause(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId)!;
    if (!ACTIVE_PROJECT_STATUSES.has(project.status)) throw new Error(`Cannot pause a project that is ${project.status}`);
    const running = [...this.active.values()].filter((a) => a.projectId === projectId).length;
    return this.setProjectStatus(project, 'paused', running ? `Paused — ${running} running task(s) will finish, nothing new starts` : 'Paused');
  }

  resume(projectId: string): Project {
    const project = this.ctx.repos.projects.get(projectId)!;
    if (project.status !== 'paused') throw new Error(`Project is not paused (${project.status})`);
    const resumed = this.setProjectStatus(project, 'running', 'Resumed');
    this.tick(projectId);
    return this.ctx.repos.projects.get(projectId) ?? resumed;
  }

  cancelProject(projectId: string): Project {
    for (const entry of this.active.values()) {
      if (entry.projectId === projectId) { entry.reason = 'cancel'; entry.controller.abort(); }
    }
    const run = this.currentRun(projectId);
    for (const task of run ? this.ctx.repos.tasks.listByRun(run.id) : []) {
      if (['pending', 'ready', 'waiting_approval', 'blocked'].includes(task.status)) {
        this.transition(task, 'cancelled', { finishedAt: now(), error: 'Project cancelled' }, `${task.title}: cancelled`, 'warn');
      }
    }
    return this.setProjectStatus(this.ctx.repos.projects.get(projectId)!, 'cancelled', 'Project cancelled');
  }

  /** Stops dispatching and aborts running work; interrupted tasks return to "ready" for the next start. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const entry of this.active.values()) { entry.reason = 'shutdown'; entry.controller.abort(); }
    const deadline = Date.now() + 10_000;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }
}
