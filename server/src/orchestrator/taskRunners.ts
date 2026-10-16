import fs from 'node:fs';
import path from 'node:path';
import type { CompiledSkeleton, Project, Task, TestResult } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import type { AgentRunInput } from '../agents/agentExecutor.ts';
import { parseFileProtocol, parsePlan, parseVerdict, summarize, AgentOutputError, type PlanOutput } from '../agents/parsers.ts';
import { FILE_PROTOCOL, RESUME_NOTE, architecturePrompt, conflictPrompt, implementPrompt, planPrompt, reviewPrompt, testPrompt, type FailureSource } from '../agents/prompts.ts';
import { transaction } from '../db/database.ts';
import { generateReport } from '../reports/reportGenerator.ts';
import { compileWorkflow, qaVerifyNodeId, WorkflowCompileError } from '../workflows/compile.ts';
import { expandPlanRows } from '../workflows/expand.ts';
import { CommandNotAllowedError, isAllowedCommand, runAllowedCommand } from '../workspace/commandRunner.ts';
import { changedFiles, git } from '../workspace/git.ts';
import { MergeConflictError } from '../workspace/workspaceManager.ts';
import { emitProject, emitTask, getSettings, type StudioContext } from './context.ts';

export interface TaskOutcome {
  summary: string;
  filesChanged?: string[];
  testResult?: TestResult | null;
}

/** A failure that must not be retried automatically (bad configuration, rejected verdict, policy). */
export class PermanentTaskError extends Error {}

/** Verification found a defect in the code (red tests or a FAIL verdict); the scheduler's fix loop can answer it. */
export class VerificationFailedError extends Error {
  constructor(message: string, readonly source: FailureSource, readonly findings: string, readonly retryable: boolean,
    readonly testResult?: TestResult) {
    super(message);
  }
}

export interface RunnerArgs {
  ctx: StudioContext;
  project: Project;
  task: Task;
  signal: AbortSignal;
  db: import('../db/database.ts').Db;
}

const MAX_DIFF = 60_000;
const GATE_KEY = 'plan-approval';
/** First task of the fixed verification tail; it re-runs the project tests on the final integrated commit. */
const FINAL_VERIFICATION_KEY = 'security-review';

/** Hard cap of one turn or command: the workflow node's timeoutMinutes, else the setting taskTimeoutMinutes. */
function timeoutMs(ctx: StudioContext, task: Task): number {
  return (task.options.timeoutMinutes ?? getSettings(ctx).taskTimeoutMinutes) * 60_000;
}

/**
 * Hard cap for one agent turn plus the inactivity limit (an agent that keeps working is never stopped early), the
 * routing order, and the workflow node's agent override (used only when the node names a provider).
 */
function limits(ctx: StudioContext, task: Task): Pick<AgentRunInput, 'timeoutMs' | 'idleTimeoutMs' | 'fallbackOrder' | 'explicit'> {
  const settings = getSettings(ctx);
  const { providerId, model, effort } = task.options;
  const base = { timeoutMs: timeoutMs(ctx, task), idleTimeoutMs: settings.idleTimeoutMinutes * 60_000, fallbackOrder: settings.fallbackOrder };
  if (!providerId) return base;
  const allowFallback = ctx.repos.config.getAgentConfigs().find((c) => c.role === task.role)?.allowFallback ?? true;
  return { ...base, explicit: { providerId, model: model ?? '', effort: effort ?? '', allowFallback } };
}

const partialKey = (taskId: string): string => `partial:${taskId}`;

export function partialBranchOf(ctx: StudioContext, taskId: string): string | null {
  return ctx.repos.config.getSetting<string | null>(partialKey(taskId), null);
}

/**
 * Commits whatever an interrupted attempt left in its worktree (timeout, limit, crash, shutdown) to the task branch,
 * so the next attempt continues from it instead of starting over. Returns false when saving failed: the caller must
 * then keep the worktree, because it holds the only copy of that work.
 */
export async function savePartialWork(ctx: StudioContext, task: Task, worktreePath: string, branch: string, resumedFrom: string | null,
  alreadyCommitted = false): Promise<boolean> {
  try {
    if (await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true)) await git(worktreePath, ['merge', '--abort'], true);
    const commit = await ctx.workspace.commit(worktreePath, `wip(${task.key}): partial work from interrupted attempt ${task.attempt}`);
    if (!commit && !resumedFrom && !alreadyCommitted) return true;
    ctx.repos.config.setSetting(partialKey(task.id), branch);
    ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'task.partial', level: 'warn',
      message: `Saved the interrupted attempt's work on ${branch}; the next attempt continues from it` });
    return true;
  } catch (error) {
    ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'task.partial', level: 'error',
      message: `Could not save partial work (${(error as Error).message}); the worktree is kept at ${worktreePath} so nothing is lost`,
      data: { worktreePath, branch } });
    return false;
  }
}

function integrationPath(project: Project): string {
  if (!project.integrationPath) throw new PermanentTaskError('Project integration worktree is missing');
  return project.integrationPath;
}

function setCheckpoint(ctx: StudioContext, task: Task, checkpoint: Task['checkpoint']): Task {
  const updated = ctx.repos.tasks.update(task.id, { checkpoint });
  ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'task.checkpoint', level: 'debug',
    message: `checkpoint: ${checkpoint}`, data: { task: updated } });
  return updated;
}

/** Writes a document into the integration worktree and commits it (under the project's integration lock). */
async function commitDocument(ctx: StudioContext, project: Project, relativePath: string, content: string, message: string): Promise<void> {
  await ctx.integrationLock.run(project.id, async () => {
    const root = integrationPath(project);
    ctx.workspace.applyEdits(root, [{ path: relativePath, content }]);
    await ctx.workspace.commit(root, message);
  });
}

// ------------------------------------------------------------------ plan

/** The compiled skeleton of the run's workflow snapshot (the graph the run was started with). */
function runSkeleton(ctx: StudioContext, project: Project, runId: string): { skeleton: CompiledSkeleton; qaNodeId: string | null } {
  const graph = ctx.repos.runs.snapshot(runId);
  if (!graph) throw new PermanentTaskError(`Run ${runId} was not found`);
  try {
    const { skeleton } = compileWorkflow(graph, { maxAttempts: getSettings(ctx).defaultMaxAttempts, testCommand: project.testCommand });
    return { skeleton, qaNodeId: qaVerifyNodeId(graph) };
  } catch (error) {
    if (error instanceof WorkflowCompileError) throw new PermanentTaskError(error.message);
    throw error;
  }
}

/**
 * Adds the PM's tasks, V1's qa-verify rule and the workflow's downstream steps (Standard: the verification tail behind the
 * plan-approval gate) to the plan task's run, in one transaction (WORKFLOW_ENGINE_SPEC.md §6.3).
 */
export function expandPlan(ctx: StudioContext, args: { db: RunnerArgs['db']; project: Project; runId: string }, plan: PlanOutput): Task[] {
  const { project, runId } = args;
  const { skeleton, qaNodeId } = runSkeleton(ctx, project, runId);
  const rows = expandPlanRows(plan, skeleton, {
    maxAttempts: getSettings(ctx).defaultMaxAttempts, startOrder: ctx.repos.tasks.maxOrderIndexForRun(runId) + 1,
    testCommand: project.testCommand, existingKeys: ctx.repos.tasks.listByRun(runId).map((t) => t.key), qaNodeId,
  });
  return transaction(args.db, () => rows.map((row) => ctx.repos.tasks.create(project.id, { ...row, runId })));
}

/** PM tasks of a role the workflow has no slot for still run (nothing the PM plans is dropped); the run timeline says so. */
function noteUnslottedTasks(ctx: StudioContext, task: Task, plan: PlanOutput, created: Task[]): void {
  const planned = new Set(plan.tasks.map((t) => t.key));
  const unslotted = created.filter((t) => planned.has(t.key) && !t.nodeId);
  if (!unslotted.length) return;
  const roles = [...new Set(unslotted.map((t) => AGENT_ROLE_INFO[t.role].name))].join(', ');
  ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: 'pm', type: 'run.note', level: 'warn',
    message: `The workflow has no slot for ${roles}: ${unslotted.map((t) => t.key).join(', ')} run with the role's agent settings`,
    data: { runId: task.runId, tasks: unslotted.map((t) => t.key) } });
}

async function runPlan({ ctx, project, task, signal, db }: RunnerArgs): Promise<TaskOutcome> {
  const output = await ctx.executor.run({
    project, task, role: 'pm', prompt: () => planPrompt(project), cwd: integrationPath(project), mode: 'readonly',
    signal, ...limits(ctx, task),
  });
  const plan = parsePlan(output.text);
  const created = expandPlan(ctx, { db, project, runId: task.runId }, plan);
  for (const t of created) emitTask(ctx, t, `Task planned: ${t.title}`);
  noteUnslottedTasks(ctx, task, plan, created);
  return { summary: `Planned ${plan.tasks.length} implementation tasks (+${created.length - plan.tasks.length} verification steps).` };
}

// ------------------------------------------------------------------ architecture

async function runArchitecture({ ctx, project, task, signal }: RunnerArgs): Promise<TaskOutcome> {
  const tasks = ctx.repos.tasks.listByRun(task.runId).filter((t) => t.kind === 'implement' || t.kind === 'test');
  const output = await ctx.executor.run({
    project, task, role: 'architect', prompt: () => architecturePrompt(project, tasks), cwd: integrationPath(project),
    mode: 'readonly', signal, ...limits(ctx, task),
  });
  const markdown = output.text.trim();
  if (markdown.length < 40) throw new AgentOutputError('Architect returned an empty plan');
  const updated = ctx.repos.projects.update(project.id, { planMarkdown: markdown });
  emitProject(ctx, updated, 'Technical plan generated');
  await commitDocument(ctx, project, 'docs/IMPLEMENTATION_PLAN.md', `${markdown}\n`, 'docs: implementation plan (Architect agent)');
  return { summary: summarize(markdown, 400), filesChanged: ['docs/IMPLEMENTATION_PLAN.md'] };
}

// ------------------------------------------------------------------ implement / test

async function runInWorktree(args: RunnerArgs, buildPrompt: (editsFiles: boolean) => string, requireChanges: boolean): Promise<{ summary: string; files: string[] }> {
  const { ctx, signal } = args;
  let { task } = args;
  const project = ctx.repos.projects.get(args.project.id)!;
  const resumedFrom = partialBranchOf(ctx, task.id);
  const { worktreePath, branch } = await ctx.workspace.createTaskWorktree(project, task, resumedFrom ?? undefined);
  task = ctx.repos.tasks.update(task.id, { worktreePath, branch });
  task = setCheckpoint(ctx, task, 'worktree');
  if (resumedFrom) {
    ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'task.resume',
      message: `Continuing from the work saved by the interrupted attempt (${resumedFrom})` });
  }
  const prompt = resumedFrom ? (edits: boolean) => `${RESUME_NOTE}

${buildPrompt(edits)}` : buildPrompt;
  let committed = false;
  let keepWorktree = false;
  try {
    const output = await ctx.executor.run({
      project, task, role: task.role, prompt, cwd: worktreePath, mode: 'edit', signal, ...limits(ctx, task),
    });
    let summary = summarize(output.text);
    if (!output.editsFiles) {
      const protocol = parseFileProtocol(output.text);
      ctx.workspace.applyEdits(worktreePath, protocol.files);
      summary = protocol.summary || summary;
    }
    task = setCheckpoint(ctx, task, 'agent_done');
    const commit = await ctx.workspace.commit(worktreePath, `${task.kind === 'test' ? 'test' : 'feat'}(${task.key}): ${task.title}\n\nAgent: ${AGENT_ROLE_INFO[task.role].name}`);
    if (!commit) {
      if (requireChanges) throw new AgentOutputError('The agent finished without changing any file');
      return { summary, files: [] };
    }
    task = setCheckpoint(ctx, task, 'committed');
    committed = true;
    const files = await integrate({ ...args, task }, project, worktreePath, branch);
    setCheckpoint(ctx, task, 'merged');
    if (resumedFrom) ctx.repos.config.setSetting(partialKey(task.id), null);
    ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'git.merge',
      message: `Merged ${files.length} file(s) from ${branch}`, data: { files } });
    return { summary, files };
  } catch (error) {
    if (!(error instanceof AgentOutputError) || committed) {
      keepWorktree = !(await savePartialWork(ctx, task, worktreePath, branch, resumedFrom, committed));
    }
    throw error;
  } finally {
    if (!keepWorktree) await ctx.workspace.removeWorktree(project, worktreePath).catch(() => undefined);
  }
}

const MAX_CONFLICT_ROUNDS = 2;
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

/** Who answers merge conflicts while a branch is integrated: a task's agent or a workspace session's agent. */
export interface ConflictResolver {
  /** Name used in the message of the merge of the integration branch into the worktree ("merge <target> into <key>"). */
  key: string;
  /** Message of the merge commit on the integration branch. */
  mergeMessage: string;
  /** Has the owning agent remove the conflict markers in `files` of the worktree, verifies and commits the result. */
  resolve: (files: string[], target: string) => Promise<void>;
}

/**
 * Merges the task branch into the integration branch. When parallel work changed the same lines, the integration
 * branch is merged into the task worktree and the task's own agent resolves the conflict markers; the result is
 * verified (no markers left), committed and merged again.
 */
async function integrate(args: RunnerArgs, project: Project, worktreePath: string, branch: string): Promise<string[]> {
  const { ctx, task } = args;
  return integrateBranch(ctx, project, worktreePath, branch, {
    key: task.key,
    mergeMessage: `merge ${task.key}: ${task.title}`,
    resolve: (files, target) => askAgentToResolve(args, project, worktreePath, files, target),
  });
}

/** The integrate() path for any branch with its own worktree (tasks and edit-mode workspace sessions). */
export async function integrateBranch(ctx: StudioContext, project: Project, worktreePath: string, branch: string,
  resolver: ConflictResolver): Promise<string[]> {
  await clearLeftoverMarkers(project, worktreePath, resolver);
  for (let round = 0; ; round += 1) {
    try {
      return await ctx.integrationLock.run(project.id, async () => {
        const before = await git(integrationPath(project), ['rev-parse', 'HEAD']);
        await ctx.workspace.mergeIntoIntegration(project, branch, resolver.mergeMessage);
        return changedFiles(integrationPath(project), before);
      });
    } catch (error) {
      if (!(error instanceof MergeConflictError) || round >= MAX_CONFLICT_ROUNDS) throw error;
      await resolveConflicts(project, worktreePath, resolver);
    }
  }
}

async function resolveConflicts(project: Project, worktreePath: string, resolver: ConflictResolver): Promise<void> {
  const target = project.integrationBranch!;
  await git(worktreePath, ['merge', '--no-ff', '-m', `merge ${target} into ${resolver.key}`, target], true);
  const conflicted = (await git(worktreePath, ['diff', '--name-only', '--diff-filter=U'])).split(/\r?\n/).filter(Boolean);
  if (!conflicted.length) return; // the integration branch merged cleanly into the task branch
  try {
    await resolver.resolve(conflicted, target);
  } catch (error) {
    await git(worktreePath, ['merge', '--abort'], true);
    throw error;
  }
}

/** The files among `files` that still contain conflict markers. */
export function filesWithConflictMarkers(worktreePath: string, files: string[]): string[] {
  return files.filter((file) => {
    const full = path.join(worktreePath, file);
    return fs.existsSync(full) && CONFLICT_MARKER.test(fs.readFileSync(full, 'utf8'));
  });
}

/** Files changed on this task branch (vs the integration branch) that still contain conflict markers. */
async function filesWithMarkers(project: Project, worktreePath: string): Promise<string[]> {
  const changed = (await git(worktreePath, ['diff', '--name-only', `${project.integrationBranch}...HEAD`])).split(/\r?\n/).filter(Boolean);
  return changed.filter((file) => {
    const full = path.join(worktreePath, file);
    return fs.existsSync(full) && fs.statSync(full).size < 2_000_000 && CONFLICT_MARKER.test(fs.readFileSync(full, 'utf8'));
  });
}

async function clearLeftoverMarkers(project: Project, worktreePath: string, resolver: ConflictResolver): Promise<void> {
  const marked = await filesWithMarkers(project, worktreePath);
  if (!marked.length) return;
  await resolver.resolve(marked, project.integrationBranch!);
}

async function askAgentToResolve(args: RunnerArgs, project: Project, worktreePath: string, conflicted: string[], target: string): Promise<void> {
  const { ctx, task, signal } = args;
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'git.conflict', level: 'warn',
    message: `Other agents changed the same lines in ${conflicted.length} file(s) (${conflicted.slice(0, 4).join(', ')}); asking ${AGENT_ROLE_INFO[task.role].name} to resolve it`,
    data: { files: conflicted } });
  {
    const output = await ctx.executor.run({
      project, task, role: task.role, prompt: (edits) => `${conflictPrompt(task, conflicted)}${edits ? '' : `\n\n${FILE_PROTOCOL}`}`,
      cwd: worktreePath, mode: 'edit', signal, ...limits(ctx, task),
    });
    if (!output.editsFiles) ctx.workspace.applyEdits(worktreePath, parseFileProtocol(output.text).files);
    const unresolved = filesWithConflictMarkers(worktreePath, conflicted);
    if (unresolved.length) throw new AgentOutputError(`Conflict markers are still present in: ${unresolved.join(', ')}`);
    await ctx.workspace.commit(worktreePath, `merge: resolve conflicts with ${target} in ${task.key}`);
    ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'git.conflict',
      message: `Conflicts resolved in ${conflicted.length} file(s); integrating again` });
  }
}

async function runImplement(args: RunnerArgs): Promise<TaskOutcome> {
  const result = await runInWorktree(args, (edits) => implementPrompt(args.project, args.task, edits), true);
  return { summary: result.summary, filesChanged: result.files };
}

export function approvedCommands(ctx: StudioContext, projectId: string): string[] {
  return ctx.repos.config.getSetting<string[]>(`approvedCommands:${projectId}`, []);
}

/** True when this verification task is running again after a fix round made for it (dependencies are run-scoped keys). */
const isRerunAfterFix = (task: Task): boolean => task.dependsOn.some((key) => key.startsWith(`fix-${task.key}-`));

/** The test command of a task: a QA node's override on `test` tasks, else the project's. */
const testCommandOf = (project: Project, task: Task): string =>
  (task.kind === 'test' && task.options.command?.trim()) || project.testCommand;

/**
 * V1 approval flow for a command outside the allowlist: one pending 'command' approval per command (approving it
 * retries the task), and the task fails permanently until then.
 */
function requestCommandApproval(ctx: StudioContext, project: Project, task: Task, command: string, label: 'Test command' | 'Command'): never {
  if (!ctx.repos.approvals.listByProject(project.id).some((a) => a.kind === 'command' && a.status === 'pending' && a.details.command === command)) {
    const approval = ctx.repos.approvals.create({ projectId: project.id, taskId: task.id, kind: 'command',
      title: `Allow ${label.toLowerCase()} "${command}"?`, details: { command, reason: 'not in the built-in allowlist' } });
    ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'approval.updated', level: 'warn',
      message: approval.title, data: { approval } });
  }
  throw new PermanentTaskError(`${label} "${command}" needs approval (see Pending approvals)`);
}

/** Runs the task's test command on the integration branch and records it on the task; throws when red. */
async function runProjectTests({ ctx, project, task, signal }: RunnerArgs, approved: boolean): Promise<TestResult> {
  const command = testCommandOf(project, task);
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'test.started', message: `Running ${command}` });
  const result = await ctx.integrationLock.run(project.id, () => runAllowedCommand(command, integrationPath(project), {
    signal, timeoutMs: timeoutMs(ctx, task), approved,
  }));
  ctx.repos.tasks.update(task.id, { testResult: result });
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'test.result', level: result.passed ? 'info' : 'error',
    message: `${command}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.summary}, exit ${result.exitCode})`, data: { testResult: result } });
  if (!result.passed) {
    throw new VerificationFailedError(`Tests failed: ${result.summary} (exit ${result.exitCode})`, 'tests',
      `${command}: ${result.summary} (exit ${result.exitCode})

${result.outputTail}`, true, result);
  }
  return result;
}

async function runTest(args: RunnerArgs): Promise<TaskOutcome> {
  const { ctx, project, task } = args;
  const command = testCommandOf(project, task);
  const approved = approvedCommands(ctx, project.id).includes(command);
  if (!isAllowedCommand(command) && !approved) requestCommandApproval(ctx, project, task, command, 'Test command');
  // After a fix round the tests were already written: re-run them only. Letting QA write new tests on
  // every re-run keeps adding new failures, and the fix loop never converges.
  const written = isRerunAfterFix(task)
    ? { summary: 'Re-ran the existing tests after the fix', files: [] as string[] }
    : await runInWorktree(args, (edits) => testPrompt(project, task, edits), false);
  const result = await runProjectTests(args, approved);
  return { summary: `${written.summary} — tests passed: ${result.summary}`, filesChanged: written.files, testResult: result };
}

// ------------------------------------------------------------------ reviews

function latestTestSummary(ctx: StudioContext, runId: string): string {
  const tests = ctx.repos.tasks.listByRun(runId).filter((t) => t.testResult);
  if (!tests.length) return 'No test run recorded.';
  return tests.map((t) => `${t.key}: ${t.testResult!.command} -> ${t.testResult!.passed ? 'PASSED' : 'FAILED'} (${t.testResult!.summary})`).join('\n');
}

async function runReview(args: RunnerArgs): Promise<TaskOutcome> {
  const { ctx, project, task, signal } = args;
  // The security review is the final verification barrier: whatever the PM's plan order was, the project tests run on
  // the fully integrated code before any review can pass. A fix made for review findings also changes code after the
  // QA test run, so a re-run after a fix checks the tests first as well.
  const command = testCommandOf(project, task);
  const approved = Boolean(command) && approvedCommands(ctx, project.id).includes(command);
  const runnable = Boolean(command) && (approved || isAllowedCommand(command));
  const finalBarrier = task.key === FINAL_VERIFICATION_KEY;
  if (finalBarrier && !runnable) throw new PermanentTaskError(`Test command "${command}" must be allowed before the final verification`);
  if ((finalBarrier || isRerunAfterFix(task)) && runnable) await runProjectTests(args, approved);
  const root = integrationPath(project);
  // Each run reviews its own change: from the commit the run started on (run 1 / backfill: the project's base commit).
  const base = ctx.repos.runs.get(task.runId)?.baseCommit ?? project.baseCommit;
  let diff = await git(root, ['diff', `${base}..HEAD`, '--', '.', ':(exclude).asf-script.json']);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n…(diff truncated)`;
  const output = await ctx.executor.run({
    project, task, role: task.role, prompt: () => reviewPrompt(project, task, diff || '(no changes)', latestTestSummary(ctx, task.runId)),
    cwd: root, mode: 'readonly', signal, ...limits(ctx, task),
  });
  const verdict = parseVerdict(output.text);
  const review = output.text.trim().slice(0, 20_000);
  if (!verdict) throw new AgentOutputError('Review did not end with "VERDICT: PASS" or "VERDICT: FAIL"');
  ctx.repos.tasks.update(task.id, { resultSummary: review });
  if (verdict === 'fail') throw new VerificationFailedError(`${AGENT_ROLE_INFO[task.role].name} verdict: FAIL — see review findings`, 'review', review, false);
  return { summary: review };
}

// ------------------------------------------------------------------ report

async function runReport({ ctx, project }: RunnerArgs): Promise<TaskOutcome> {
  const fresh = ctx.repos.projects.get(project.id)!;
  const markdown = await generateReport(ctx, fresh);
  const updated = ctx.repos.projects.update(project.id, { reportMarkdown: markdown });
  emitProject(ctx, updated, 'Delivery report generated');
  await commitDocument(ctx, fresh, 'ASF_REPORT.md', markdown, 'docs: delivery report (AI Software Factory Studio)');
  if (!fs.existsSync(path.join(integrationPath(fresh), 'ASF_REPORT.md'))) throw new Error('Report file was not written');
  return { summary: 'Delivery report generated (ASF_REPORT.md on the integration branch).', filesChanged: ['ASF_REPORT.md'] };
}

// ------------------------------------------------------------------ workflow tool / notify nodes

const COMMAND_TAIL = 2000;

/** A tool node: one command in the integration worktree (allowlist, else V1's approval flow). Not a fix-loop source. */
async function runCommand({ ctx, project, task, signal }: RunnerArgs): Promise<TaskOutcome> {
  const command = task.options.command?.trim();
  if (!command) throw new PermanentTaskError('The Run command node has no command');
  const approved = approvedCommands(ctx, project.id).includes(command);
  if (!isAllowedCommand(command) && !approved) requestCommandApproval(ctx, project, task, command, 'Command');
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'command.started', message: `Running ${command}` });
  const result = await ctx.integrationLock.run(project.id, () => runAllowedCommand(command, integrationPath(project), {
    signal, timeoutMs: timeoutMs(ctx, task), approved,
  }));
  const tail = result.outputTail.slice(-COMMAND_TAIL).trim();
  const status = result.summary === 'cancelled' || /^timed out/.test(result.summary) ? `, ${result.summary}` : '';
  const summary = `${command}: exit ${result.exitCode}${status}${tail ? `\n\n${tail}` : ''}`;
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'command.result', level: result.passed ? 'info' : 'error',
    message: `${command}: exit ${result.exitCode}${status}`, data: { command, exitCode: result.exitCode, durationMs: result.durationMs } });
  if (!result.passed) throw new Error(`Command failed — ${summary}`);
  return { summary };
}

const DEFAULT_NOTIFY_MESSAGE = '{{project}}: run {{run}} is {{status}}';

/** A notify node: an in-app notification event; the message template knows {{project}}, {{run}} and {{status}}. */
async function runNotify({ ctx, project, task }: RunnerArgs): Promise<TaskOutcome> {
  const fresh = ctx.repos.projects.get(project.id) ?? project;
  const values: Record<string, string> = {
    project: fresh.name, run: String(ctx.repos.runs.get(task.runId)?.number ?? ''), status: fresh.status.replaceAll('_', ' '),
  };
  const template = task.options.message?.trim() || DEFAULT_NOTIFY_MESSAGE;
  const message = template.replace(/\{\{\s*(project|run|status)\s*\}\}/g, (_, key: string) => values[key]).slice(0, 2000);
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'notification', level: 'info', message,
    data: { message, runId: task.runId } });
  return { summary: message };
}

export const TASK_RUNNERS: Record<Exclude<Task['kind'], 'gate'>, (args: RunnerArgs) => Promise<TaskOutcome>> = {
  plan: runPlan,
  architecture: runArchitecture,
  implement: runImplement,
  test: runTest,
  security: runReview,
  review: runReview,
  report: runReport,
  command: runCommand,
  notify: runNotify,
};

export { CommandNotAllowedError, GATE_KEY };
