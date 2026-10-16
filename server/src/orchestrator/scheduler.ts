import fs from 'node:fs';
import type { Project, ProjectStatus, Task, TaskStatus, TestResult } from '@asf/shared';
import type { Db } from '../db/database.ts';
import { dependenciesMet, dependencyFailed, dependantsOf } from '../domain/taskGraph.ts';
import { assertTransition } from '../domain/taskStateMachine.ts';
import { NoProviderError } from '../providers/registry.ts';
import { ProviderError } from '../providers/types.ts';
import { redact } from '../security/redact.ts';
import { emitProject, emitTask, getSettings, type StudioContext } from './context.ts';
import { insertFixTask } from './fixLoop.ts';
import type { ProcessSlotRelease } from './processBudget.ts';
import { partialBranchOf, PermanentTaskError, savePartialWork, TASK_RUNNERS, VerificationFailedError } from './taskRunners.ts';

type StopReason = 'cancel' | 'shutdown' | null;

const ACTIVE_PROJECT_STATUSES: ReadonlySet<ProjectStatus> = new Set(['planning', 'running', 'awaiting_approval']);
const now = (): string => new Date().toISOString();

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

  setProjectStatus(project: Project, status: ProjectStatus, message?: string): Project {
    if (project.status === status) return project;
    const updated = this.ctx.repos.projects.update(project.id, { status });
    emitProject(this.ctx, updated, message ?? `Project ${status.replace('_', ' ')}`);
    return updated;
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
    let tasks = this.demoteUnmet(this.promote(this.ctx.repos.tasks.listByProject(projectId)));
    for (const gate of tasks.filter((t) => t.kind === 'gate' && t.status === 'ready')) this.openGate(project, gate);
    tasks = this.ctx.repos.tasks.listByProject(projectId);

    const limit = getSettings(this.ctx).maxParallelTasks;
    for (const task of tasks.filter((t) => t.status === 'ready' && t.kind !== 'gate')) {
      if (this.active.size >= limit) break;
      this.start(project, task);
    }
    project = this.ctx.repos.projects.get(projectId)!;
    const next = this.deriveStatus(project, this.ctx.repos.tasks.listByProject(projectId));
    if (next) this.setProjectStatus(project, next);
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
      if (changed) tasks = this.ctx.repos.tasks.listByProject(initial[0]?.projectId ?? '');
    }
    return tasks;
  }

  /** Dispatch guard: a "ready" task whose dependencies are not all completed goes back to "pending" instead of running. */
  private demoteUnmet(tasks: Task[]): Task[] {
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const unmet = tasks.filter((t) => t.status === 'ready' && !dependenciesMet(t, byKey));
    if (!unmet.length) return tasks;
    for (const task of unmet) this.transition(task, 'pending', {}, `${task.title}: waiting for its dependencies`, 'warn');
    return this.promote(this.ctx.repos.tasks.listByProject(tasks[0].projectId));
  }

  private openGate(project: Project, gate: Task): void {
    this.transition(gate, 'waiting_approval', { startedAt: now() }, 'Plan is ready for your approval');
    if (this.ctx.repos.approvals.pendingForTask(gate.id)) return;
    const planned = this.ctx.repos.tasks.listByProject(project.id).filter((t) => !['plan', 'architecture', 'gate'].includes(t.kind));
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
    if (tasks.every((t) => t.status === 'completed')) return 'completed';
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
      if (task.kind === 'plan' && this.ctx.repos.tasks.listByProject(projectId).some((t) => t.kind === 'implement' || t.kind === 'test')) {
        this.complete(task, { summary: 'Plan was already expanded before an interruption.' });
        return;
      }
      release = await this.acquireSlot(project, task, signal);
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
      const { maxFixRounds } = getSettings(this.ctx);
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
    const all = this.ctx.repos.tasks.listByProject(task.projectId);
    // A retried task whose dependencies are not completed waits in "pending" (promotion decides), never jumps the queue.
    const target: TaskStatus = dependenciesMet(task, new Map(all.map((t) => [t.key, t]))) ? 'ready' : 'pending';
    const retried = this.transition(task, target, { maxAttempts: Math.max(task.maxAttempts, task.attempt + 1), error: null, checkpoint: 'none' },
      `${task.title}: manual retry${target === 'pending' ? ' (waits for its dependencies)' : ''}`);
    for (const dependant of dependantsOf(task.key, all).filter((t) => t.status === 'blocked')) {
      this.transition(dependant, 'pending', {}, `${dependant.title}: unblocked`);
    }
    const project = this.ctx.repos.projects.get(task.projectId)!;
    if (project.status === 'failed' || project.status === 'cancelled') this.setProjectStatus(project, 'running', 'Project resumed after retry');
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
    for (const task of this.ctx.repos.tasks.listByProject(projectId)) {
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
