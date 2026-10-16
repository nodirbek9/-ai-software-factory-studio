import fs from 'node:fs';
import path from 'node:path';
import type { Project, Task, TestResult } from '@asf/shared';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { parseFileProtocol, parsePlan, parseVerdict, summarize, AgentOutputError, type PlanOutput } from '../agents/parsers.ts';
import { FILE_PROTOCOL, RESUME_NOTE, architecturePrompt, conflictPrompt, implementPrompt, planPrompt, reviewPrompt, testPrompt, type FailureSource } from '../agents/prompts.ts';
import { transaction } from '../db/database.ts';
import { validateGraph } from '../domain/taskGraph.ts';
import { generateReport } from '../reports/reportGenerator.ts';
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

function timeoutMs(ctx: StudioContext): number {
  return getSettings(ctx).taskTimeoutMinutes * 60_000;
}

/** Hard cap for one agent turn plus the inactivity limit (an agent that keeps working is never stopped early). */
function limits(ctx: StudioContext): { timeoutMs: number; idleTimeoutMs: number } {
  const settings = getSettings(ctx);
  return { timeoutMs: settings.taskTimeoutMinutes * 60_000, idleTimeoutMs: settings.idleTimeoutMinutes * 60_000 };
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

/** Adds the PM's tasks plus the mandatory verification tail, all behind the plan-approval gate. */
export function expandPlan(ctx: StudioContext, args: { db: RunnerArgs['db']; project: Project }, plan: PlanOutput): Task[] {
  const { project } = args;
  const reserved = new Set(['plan', 'architecture', GATE_KEY, 'security-review', 'final-review', 'delivery-report', 'qa-verify']);
  const clash = plan.tasks.find((t) => reserved.has(t.key));
  if (clash) throw new AgentOutputError(`Plan uses a reserved task key: ${clash.key}`);
  const graphError = validateGraph(plan.tasks);
  if (graphError) throw new AgentOutputError(`Invalid task graph: ${graphError}`);

  const maxAttempts = getSettings(ctx).defaultMaxAttempts;
  const dependedOn = new Set(plan.tasks.flatMap((t) => t.dependsOn));
  let leaves = plan.tasks.filter((t) => !dependedOn.has(t.key)).map((t) => t.key);
  const hasQa = plan.tasks.some((t) => t.role === 'qa');
  let order = ctx.repos.tasks.maxOrderIndex(project.id) + 1;

  return transaction(args.db, () => {
    const created: Task[] = [];
    for (const t of plan.tasks) {
      created.push(ctx.repos.tasks.create(project.id, {
        key: t.key, title: t.title, description: t.description, role: t.role,
        kind: t.role === 'qa' ? 'test' : 'implement',
        dependsOn: t.dependsOn.length ? t.dependsOn : [GATE_KEY], orderIndex: order++, maxAttempts,
      }));
    }
    if (!hasQa) {
      created.push(ctx.repos.tasks.create(project.id, {
        key: 'qa-verify', title: 'Verify with automated tests', role: 'qa', kind: 'test', orderIndex: order++, maxAttempts,
        description: `Add tests covering the specification and run \`${project.testCommand}\`.`, dependsOn: leaves,
      }));
      leaves = ['qa-verify'];
    }
    const tail: { key: string; title: string; role: Task['role']; kind: Task['kind']; description: string }[] = [
      { key: 'security-review', title: 'Security review of integrated change', role: 'security', kind: 'security', description: 'Review the full diff for vulnerabilities.' },
      { key: 'final-review', title: 'Final code review', role: 'reviewer', kind: 'review', description: 'Review correctness, quality and spec adherence.' },
      { key: 'delivery-report', title: 'Delivery report', role: 'pm', kind: 'report', description: 'Generate the final implementation report.' },
    ];
    let previous = leaves;
    for (const t of tail) {
      created.push(ctx.repos.tasks.create(project.id, { ...t, dependsOn: previous, orderIndex: order++, maxAttempts }));
      previous = [t.key];
    }
    return created;
  });
}

async function runPlan({ ctx, project, task, signal, db }: RunnerArgs): Promise<TaskOutcome> {
  const output = await ctx.executor.run({
    project, task, role: 'pm', prompt: () => planPrompt(project), cwd: integrationPath(project), mode: 'readonly',
    signal, ...limits(ctx), fallbackOrder: getSettings(ctx).fallbackOrder,
  });
  const plan = parsePlan(output.text);
  const created = expandPlan(ctx, { db, project }, plan);
  for (const t of created) emitTask(ctx, t, `Task planned: ${t.title}`);
  return { summary: `Planned ${plan.tasks.length} implementation tasks (+${created.length - plan.tasks.length} verification steps).` };
}

// ------------------------------------------------------------------ architecture

async function runArchitecture({ ctx, project, task, signal }: RunnerArgs): Promise<TaskOutcome> {
  const tasks = ctx.repos.tasks.listByProject(project.id).filter((t) => t.kind === 'implement' || t.kind === 'test');
  const output = await ctx.executor.run({
    project, task, role: 'architect', prompt: () => architecturePrompt(project, tasks), cwd: integrationPath(project),
    mode: 'readonly', signal, ...limits(ctx), fallbackOrder: getSettings(ctx).fallbackOrder,
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
      project, task, role: task.role, prompt, cwd: worktreePath, mode: 'edit', signal,
      ...limits(ctx), fallbackOrder: getSettings(ctx).fallbackOrder,
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
      cwd: worktreePath, mode: 'edit', signal, ...limits(ctx), fallbackOrder: getSettings(ctx).fallbackOrder,
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

/** True when this verification task is running again after a fix round made for it. */
const isRerunAfterFix = (task: Task): boolean => task.dependsOn.some((key) => key.startsWith(`fix-${task.key}-`));

/** Runs the project's test command on the integration branch and records it on the task; throws when red. */
async function runProjectTests({ ctx, project, task, signal }: RunnerArgs, approved: boolean): Promise<TestResult> {
  const command = project.testCommand;
  ctx.events.emit({ projectId: project.id, taskId: task.id, role: task.role, type: 'test.started', message: `Running ${command}` });
  const result = await ctx.integrationLock.run(project.id, () => runAllowedCommand(command, integrationPath(project), {
    signal, timeoutMs: timeoutMs(ctx), approved,
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
  const command = project.testCommand;
  const approved = approvedCommands(ctx, project.id).includes(command);
  if (!isAllowedCommand(command) && !approved) {
    if (!ctx.repos.approvals.listByProject(project.id).some((a) => a.kind === 'command' && a.status === 'pending' && a.details.command === command)) {
      const approval = ctx.repos.approvals.create({ projectId: project.id, taskId: task.id, kind: 'command',
        title: `Allow test command "${command}"?`, details: { command, reason: 'not in the built-in allowlist' } });
      ctx.events.emit({ projectId: project.id, taskId: task.id, role: 'qa', type: 'approval.updated', level: 'warn',
        message: approval.title, data: { approval } });
    }
    throw new PermanentTaskError(`Test command "${command}" needs approval (see Pending approvals)`);
  }
  // After a fix round the tests were already written: re-run them only. Letting QA write new tests on
  // every re-run keeps adding new failures, and the fix loop never converges.
  const written = isRerunAfterFix(task)
    ? { summary: 'Re-ran the existing tests after the fix', files: [] as string[] }
    : await runInWorktree(args, (edits) => testPrompt(project, task, edits), false);
  const result = await runProjectTests(args, approved);
  return { summary: `${written.summary} — tests passed: ${result.summary}`, filesChanged: written.files, testResult: result };
}

// ------------------------------------------------------------------ reviews

function latestTestSummary(ctx: StudioContext, projectId: string): string {
  const tests = ctx.repos.tasks.listByProject(projectId).filter((t) => t.testResult);
  if (!tests.length) return 'No test run recorded.';
  return tests.map((t) => `${t.key}: ${t.testResult!.command} -> ${t.testResult!.passed ? 'PASSED' : 'FAILED'} (${t.testResult!.summary})`).join('\n');
}

async function runReview(args: RunnerArgs): Promise<TaskOutcome> {
  const { ctx, project, task, signal } = args;
  // The security review is the final verification barrier: whatever the PM's plan order was, the project tests run on
  // the fully integrated code before any review can pass. A fix made for review findings also changes code after the
  // QA test run, so a re-run after a fix checks the tests first as well.
  const command = project.testCommand;
  const approved = Boolean(command) && approvedCommands(ctx, project.id).includes(command);
  const runnable = Boolean(command) && (approved || isAllowedCommand(command));
  const finalBarrier = task.key === FINAL_VERIFICATION_KEY;
  if (finalBarrier && !runnable) throw new PermanentTaskError(`Test command "${command}" must be allowed before the final verification`);
  if ((finalBarrier || isRerunAfterFix(task)) && runnable) await runProjectTests(args, approved);
  const root = integrationPath(project);
  let diff = await git(root, ['diff', `${project.baseCommit}..HEAD`, '--', '.', ':(exclude).asf-script.json']);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n…(diff truncated)`;
  const output = await ctx.executor.run({
    project, task, role: task.role, prompt: () => reviewPrompt(project, task, diff || '(no changes)', latestTestSummary(ctx, project.id)),
    cwd: root, mode: 'readonly', signal, ...limits(ctx), fallbackOrder: getSettings(ctx).fallbackOrder,
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

export const TASK_RUNNERS: Record<Exclude<Task['kind'], 'gate'>, (args: RunnerArgs) => Promise<TaskOutcome>> = {
  plan: runPlan,
  architecture: runArchitecture,
  implement: runImplement,
  test: runTest,
  security: runReview,
  review: runReview,
  report: runReport,
};

export { CommandNotAllowedError, GATE_KEY };
