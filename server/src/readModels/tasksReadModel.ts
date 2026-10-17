import fs from 'node:fs';
import type { Project, Run, Task, TaskDetail, TaskDiff, TaskKind, TaskQuery, TaskRow, TasksResponse } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { fixRoundsUsed, maxFixRoundsFor } from '../orchestrator/fixLoop.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { redact } from '../security/redact.ts';
import { isSensitivePath } from '../security/sensitiveFiles.ts';
import { git } from '../workspace/git.ts';

// Tasks board/list, task drawer and task diff (PHASE_5.md, UI_SCREEN_SPECIFICATIONS.md §5). Git access is read-only (P5-1).

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const MAX_EVENTS = 300;
const MAX_DIFF_CHARS = 300 * 1024;
/** Just under processRunner's 2 MB capture: output this long may have lost its beginning. */
const SAFE_GIT_OUTPUT = 2 * 1024 * 1024 - 1024;
const MAX_BRANCH_WALK = 2000;
const VERIFICATION_KINDS: ReadonlySet<TaskKind> = new Set(['test', 'security', 'review']);
const REVIEW_KINDS: ReadonlySet<TaskKind> = new Set(['security', 'review']);
/** Kinds that work in a worktree on their own branch (taskRunners.runInWorktree). */
const BRANCH_KINDS: ReadonlySet<TaskKind> = new Set(['implement', 'test']);

const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error)).slice(0, 500);

function requireTask(ctx: StudioContext, id: string): Task {
  const task = ctx.repos.tasks.get(id);
  if (!task) throw new ProjectError('Task not found', 404);
  return task;
}

/** finishedAt − startedAt, or now − startedAt while running; null when never started (or not finished). */
function durationOf(task: Task, nowMs: number): number | null {
  const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
  if (Number.isNaN(started)) return null;
  if (task.status === 'running') return Math.max(0, nowMs - started);
  const finished = task.finishedAt ? Date.parse(task.finishedAt) : Number.NaN;
  return Number.isNaN(finished) ? null : Math.max(0, finished - started);
}

function toRow(task: Task, projectName: string, run: Run | null, nowMs: number): TaskRow {
  return { ...task, projectName, runNumber: run?.number ?? null, durationMs: durationOf(task, nowMs) };
}

/** Runs by id, each read once per request. */
function runLookup(ctx: StudioContext): (runId: string) => Run | null {
  const cache = new Map<string, Run | null>();
  return (runId) => {
    if (!cache.has(runId)) cache.set(runId, ctx.repos.runs.get(runId));
    return cache.get(runId) ?? null;
  };
}

// ------------------------------------------------------------------ list

/** The project's tasks in the requested scope: its current run (active, else latest), every run, or one run. */
function scopedTasks(ctx: StudioContext, project: Project, scope: string, runOf: (id: string) => Run | null): Task[] {
  if (scope === 'all') {
    const number = (t: Task): number => runOf(t.runId)?.number ?? 0;
    return ctx.repos.tasks.listByProject(project.id).sort((a, b) => number(b) - number(a) || a.orderIndex - b.orderIndex);
  }
  if (scope === 'active') {
    const run = ctx.repos.runs.activeForProject(project.id) ?? ctx.repos.runs.latestForProject(project.id);
    return run ? ctx.repos.tasks.listByRun(run.id) : [];
  }
  return ctx.repos.tasks.listByRun(scope);
}

/** Projects in scope, most recently updated first; a run id narrows them to that run's project. */
function scopedProjects(ctx: StudioContext, query: TaskQuery, scope: string): Project[] {
  if (query.projectId && !ctx.repos.projects.get(query.projectId)) throw new ProjectError('Project not found', 404);
  let projects = ctx.repos.projects.list();
  if (scope !== 'all' && scope !== 'active') {
    const run = ctx.repos.runs.get(scope);
    if (!run) throw new ProjectError('Run not found', 404);
    projects = projects.filter((p) => p.id === run.projectId);
  }
  if (query.projectId) projects = projects.filter((p) => p.id === query.projectId);
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
}

function matcher(query: TaskQuery): (task: Task) => boolean {
  const needle = query.q?.trim().toLowerCase() ?? '';
  return (task) => (!query.role || task.role === query.role) && (!query.status || task.status === query.status)
    && (!needle || [task.key, task.title, task.description].some((text) => text.toLowerCase().includes(needle)));
}

/** `GET /api/v2/tasks`: task rows across projects (or one project / one run), filtered, at most `limit`. */
export function listTasks(ctx: StudioContext, query: TaskQuery, now = new Date()): TasksResponse {
  const scope = query.runId || 'active';
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT) || 1, 1), MAX_LIMIT);
  const runOf = runLookup(ctx);
  const matches = matcher(query);
  const tasks: TaskRow[] = [];
  let matched = 0;
  for (const project of scopedProjects(ctx, query, scope)) {
    for (const task of scopedTasks(ctx, project, scope, runOf)) {
      if (!matches(task)) continue;
      matched += 1;
      if (tasks.length < limit) tasks.push(toRow(task, project.name, runOf(task.runId), now.getTime()));
    }
  }
  return { tasks, truncated: matched > limit };
}

// ------------------------------------------------------------------ detail

/** `GET /api/v2/tasks/:id`: the task row, its run, its newest 300 events (oldest first) and verification state. */
export function taskDetail(ctx: StudioContext, id: string, now = new Date()): TaskDetail {
  const task = requireTask(ctx, id);
  const run = ctx.repos.runs.get(task.runId);
  const projectName = ctx.repos.projects.get(task.projectId)?.name ?? 'Deleted project';
  return {
    task: toRow(task, projectName, run, now.getTime()),
    run,
    events: ctx.repos.events.list({ taskId: task.id, limit: MAX_EVENTS }),
    fixRounds: VERIFICATION_KINDS.has(task.kind) ? { used: fixRoundsUsed(ctx, task.runId, task.key), max: maxFixRoundsFor(ctx, task) } : null,
    reviewText: REVIEW_KINDS.has(task.kind) ? task.resultSummary : null,
  };
}

// ------------------------------------------------------------------ diff (P5-2)

interface CommitRange {
  base: string;
  head: string;
  note: string | null;
}

/** Commit hash of a local branch, or '' when it does not exist. */
function branchHead(cwd: string, branch: string): Promise<string> {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true);
}

/**
 * The integration commit the task branch was created from: the first commit on the branch's first-parent chain that is
 * on the integration branch's first-parent chain since `since`. Unlike merge-base(branch, integration HEAD) it survives
 * the merge, and unlike the run's base commit it leaves out the work other tasks merged before this one started.
 */
async function forkPoint(cwd: string, integration: string, since: string | null, branch: string): Promise<string | null> {
  const range = since ? `${since}..refs/heads/${integration}` : `refs/heads/${integration}`;
  const mainline = new Set(lines(await git(cwd, ['log', '--first-parent', '--format=%H', range, '--'])));
  if (since) mainline.add(since);
  const walk = lines(await git(cwd, ['log', '--first-parent', '--format=%H', '-n', String(MAX_BRANCH_WALK), `refs/heads/${branch}`, '--']));
  return walk.find((sha) => mainline.has(sha)) ?? null;
}

/** This run's merge commit of the task (`merge <key>: <title>`, taskRunners.integrate) on the integration branch. */
async function mergeCommit(cwd: string, integration: string, since: string | null, key: string): Promise<{ parent: string; sha: string } | null> {
  const range = since ? `${since}..refs/heads/${integration}` : `refs/heads/${integration}`;
  const prefix = `merge ${key}: `;
  const found = lines(await git(cwd, ['log', '--first-parent', '--format=%H %s', range, '--']))
    .filter((line) => line.slice(line.indexOf(' ') + 1).startsWith(prefix));
  const oldest = found.at(-1)?.split(' ')[0]; // the first merge after the run started (keys repeat across runs)
  if (!oldest) return null;
  const parent = await git(cwd, ['rev-parse', '--verify', '--quiet', `${oldest}^1`], true);
  return parent ? { parent, sha: oldest } : null;
}

/** The task's commit range, or why there is none. */
async function taskRange(ctx: StudioContext, project: Project, task: Task, integration: string): Promise<CommitRange | string> {
  const cwd = project.workspacePath;
  const since = ctx.repos.runs.get(task.runId)?.baseCommit ?? project.baseCommit;
  if (!BRANCH_KINDS.has(task.kind)) return 'This kind of task does not work on a branch of its own';
  if (!task.branch) return 'The task has not created a branch yet';
  const head = await branchHead(cwd, task.branch);
  if (head) {
    const base = await forkPoint(cwd, integration, since, task.branch);
    if (base === head) return `No commits on ${task.branch}`;
    if (base) return { base, head, note: null };
  }
  const merge = await mergeCommit(cwd, integration, since, task.key);
  if (merge) {
    const why = head ? `the start of ${task.branch} was not found on ${integration}` : `branch ${task.branch} was removed`;
    return { base: merge.parent, head: merge.sha, note: `Showing the merge commit (${why})` };
  }
  return head ? `The start of ${task.branch} was not found on ${integration}` : `Branch ${task.branch} was removed and no merge commit was found`;
}

/** Unified diff of base..head without sensitive files, at most 300 KB. */
async function renderDiff(cwd: string, base: string, head: string): Promise<Pick<TaskDiff, 'files' | 'diff' | 'truncated'> & { omitted: number }> {
  const range = `${base}..${head}`;
  const changed = (await git(cwd, ['diff', '--no-ext-diff', '--name-only', '-z', range])).split('\0').filter(Boolean);
  const files = changed.filter((file) => !isSensitivePath(file));
  const omitted = changed.length - files.length;
  const excludes = changed.filter(isSensitivePath).map((file) => `:(exclude,literal)${file}`);
  let diff = await git(cwd, ['diff', '--no-ext-diff', range, ...(excludes.length ? ['--', '.', ...excludes] : [])]);
  if (diff.length >= SAFE_GIT_OUTPUT) diff = await diffPerFile(cwd, range, files); // the capture kept only the tail
  if (diff.length <= MAX_DIFF_CHARS) return { files, diff, truncated: false, omitted };
  return { files, diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated: it is larger than 300 KB)`, truncated: true, omitted };
}

/** A very large diff, file by file until the 300 KB budget is spent. */
async function diffPerFile(cwd: string, range: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  let size = 0;
  for (const file of files) {
    if (size > MAX_DIFF_CHARS) break;
    const part = await git(cwd, ['diff', '--no-ext-diff', range, '--', `:(literal)${file}`]);
    parts.push(part);
    size += part.length + 1;
  }
  return `${parts.join('\n')}\n`; // longer than the budget, so the caller truncates it
}

/** `GET /api/v2/tasks/:id/diff`: the task's committed change (P5-2). Git problems become a note, never an error. */
export async function taskDiff(ctx: StudioContext, id: string): Promise<TaskDiff> {
  const task = requireTask(ctx, id);
  const project = ctx.repos.projects.get(task.projectId);
  const empty = (note: string): TaskDiff => ({ taskId: task.id, base: null, head: null, files: [], diff: '', truncated: false, note });
  if (!project?.integrationBranch) return empty('The project has no integration branch yet');
  if (!fs.existsSync(project.workspacePath)) return empty(`The workspace folder is missing: ${project.workspacePath}`);
  try {
    const range = await taskRange(ctx, project, task, project.integrationBranch);
    if (typeof range === 'string') return empty(range);
    const { omitted, ...rendered } = await renderDiff(project.workspacePath, range.base, range.head);
    const notes = [range.note, omitted ? `Omitted ${omitted} sensitive file(s) (.env, keys)` : null].filter(Boolean);
    return { taskId: task.id, base: range.base, head: range.head, ...rendered, note: notes.length ? notes.join('; ') : null };
  } catch (error) {
    return empty(`Could not read the diff: ${errorText(error)}`);
  }
}
