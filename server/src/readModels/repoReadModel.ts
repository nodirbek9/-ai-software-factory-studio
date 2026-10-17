import fs from 'node:fs';
import path from 'node:path';
import type { Project, RepoBranch, RepoBranchKind, RepoConflict, RepoOverview, RepoOwner, RepoWipCommit, RepoWorktree } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { redact } from '../security/redact.ts';
import { git, isGitRepo } from '../workspace/git.ts';

// Read-only git overview of one project for the Repos page (PHASE_5.md P5-1, UI_SCREEN_SPECIFICATIONS.md §7).
// Only allowlisted read commands run (rev-parse, log, worktree list); nothing is ever written.

/** Branches shown per project (each costs two git calls); integration and studio branches come first. */
const MAX_BRANCHES = 300;
const MAX_WIP_COMMITS = 50;
const MAX_CONFLICTS = 50;
const GIT_CONCURRENCY = 6;
const WIP_PREFIX = 'wip(';
/** Conflict events of task and session integrations (taskRunners.askAgentToResolve, SessionManager). */
const CONFLICT_EVENT = 'git.conflict';

const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const errorText = (error: unknown): string => redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
/** Comparable form of a folder path (git prints forward slashes; Windows paths are case-insensitive). */
const pathKey = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Runs `work` over `items` with at most GIT_CONCURRENCY at once, keeping the order. */
async function mapLimited<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, items.length) }, worker));
  return results;
}

// ------------------------------------------------------------------ owners

interface Owners {
  byBranch: Map<string, RepoOwner>;
  byPath: Map<string, RepoOwner>;
  /** Latest task per key, for branches of earlier attempts (`<key>-a<n>`) that tasks.branch no longer names. */
  byTaskKey: Map<string, RepoOwner>;
}

function ownersOf(ctx: StudioContext, projectId: string): Owners {
  const owners: Owners = { byBranch: new Map(), byPath: new Map(), byTaskKey: new Map() };
  const tasks = ctx.repos.tasks.listByProject(projectId).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const task of tasks) { // newest last, so the latest task wins
    const owner: RepoOwner = { type: 'task', id: task.id, title: task.title, status: task.status };
    owners.byTaskKey.set(task.key, owner);
    if (task.branch) owners.byBranch.set(task.branch, owner);
    if (task.worktreePath) owners.byPath.set(pathKey(task.worktreePath), owner);
  }
  for (const session of ctx.repos.sessions.listByProject(projectId, { includeClosed: true })) {
    const owner: RepoOwner = { type: 'session', id: session.id, title: session.title, status: session.status };
    if (session.branch) owners.byBranch.set(session.branch, owner);
    if (session.worktreePath) owners.byPath.set(pathKey(session.worktreePath), owner);
  }
  return owners;
}

// ------------------------------------------------------------------ branches

const studioPrefix = (project: Project): string => `asf/${project.slug}/`;
/** Task branches are `asf/<slug>/[r<run>-]<key>-a<attempt>` (WorkspaceManager.createTaskWorktree; run prefix from run 2 on). */
const TASK_BRANCH = /^(?:r\d+-)?(.+)-a\d+$/;

function branchKind(project: Project, name: string, subject: string | null): RepoBranchKind {
  if (name === project.integrationBranch) return 'integration';
  if (!name.startsWith(studioPrefix(project))) return 'other';
  const rest = name.slice(studioPrefix(project).length);
  if (/^session-\d+$/.test(rest)) return 'session';
  // An interrupted attempt's work is committed as `wip(<key>): …` on its task branch (taskRunners.savePartialWork).
  if (TASK_BRANCH.test(rest)) return subject?.startsWith(WIP_PREFIX) ? 'partial' : 'task';
  return 'other';
}

function branchOwner(project: Project, name: string, owners: Owners): RepoOwner | null {
  const direct = owners.byBranch.get(name);
  if (direct || !name.startsWith(studioPrefix(project))) return direct ?? null;
  const key = TASK_BRANCH.exec(name.slice(studioPrefix(project).length))?.[1];
  return key ? owners.byTaskKey.get(key) ?? null : null;
}

/** Local branch names: the integration branch first, then the project's studio branches, then the rest. */
async function branchNames(cwd: string, project: Project): Promise<string[]> {
  const names = lines(await git(cwd, ['rev-parse', '--symbolic-full-name', '--branches'])).map((ref) => ref.replace(/^refs\/heads\//, ''));
  const rank = (name: string): number => (name === project.integrationBranch ? 0 : name.startsWith(studioPrefix(project)) ? 1 : 2);
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_BRANCHES);
}

/** Commits only on `integration` (behind) and only on `branch` (ahead). */
async function aheadBehind(cwd: string, integration: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const marks = await git(cwd, ['log', '--left-right', '--format=%m', `refs/heads/${integration}...refs/heads/${branch}`, '--']);
  let ahead = 0;
  let behind = 0;
  for (const mark of marks) {
    if (mark === '>') ahead += 1;
    else if (mark === '<') behind += 1;
  }
  return { ahead, behind };
}

async function readBranch(cwd: string, project: Project, integration: string | null, name: string, owners: Owners): Promise<RepoBranch> {
  const [head = '', at = '', subject = ''] = (await git(cwd, ['log', '-1', '--format=%H%x00%cI%x00%s', `refs/heads/${name}`, '--'])).split('\0');
  const counts = integration && name !== integration ? await aheadBehind(cwd, integration, name) : null;
  return {
    name, kind: branchKind(project, name, subject), head, ahead: counts?.ahead ?? null, behind: counts?.behind ?? null,
    lastCommitAt: at || null, lastCommitSubject: subject || null, owner: branchOwner(project, name, owners),
  };
}

// ------------------------------------------------------------------ worktrees, wip commits, conflicts

interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
}

/** Parses `git worktree list --porcelain` (blocks of `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`). */
function parseWorktrees(output: string): ListedWorktree[] {
  return output.split(/\r?\n\s*\r?\n/).map((block) => {
    const entry: ListedWorktree = { path: '', head: null, branch: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = path.resolve(line.slice('worktree '.length));
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    return entry;
  }).filter((entry) => entry.path);
}

function modifiedAt(folder: string): string | null {
  try {
    return fs.statSync(folder).mtime.toISOString();
  } catch {
    return null; // listed by git but the folder is gone (prunable)
  }
}

async function readWorktrees(cwd: string, owners: Owners): Promise<RepoWorktree[]> {
  return parseWorktrees(await git(cwd, ['worktree', 'list', '--porcelain'])).map((w) => ({
    path: w.path, branch: w.branch, head: w.head,
    owner: owners.byPath.get(pathKey(w.path)) ?? (w.branch ? owners.byBranch.get(w.branch) ?? null : null),
    modifiedAt: modifiedAt(w.path),
  }));
}

/** `wip(…)` commits on branches other than the integration branch that the integration branch does not contain. */
async function readWipCommits(cwd: string, integration: string | null, branches: RepoBranch[]): Promise<RepoWipCommit[]> {
  const candidates = branches.filter((b) => b.kind !== 'integration' && (b.ahead === null || b.ahead > 0));
  const perBranch = await mapLimited(candidates, async (branch) => {
    const range = integration ? `refs/heads/${integration}..refs/heads/${branch.name}` : `refs/heads/${branch.name}`;
    const out = await git(cwd, ['log', '--format=%H%x00%cI%x00%s', '--grep=^wip(', '-n', String(MAX_WIP_COMMITS), range, '--']);
    return lines(out).map((line) => line.split('\0')).filter(([, , subject]) => subject?.startsWith(WIP_PREFIX))
      .map(([sha, at, subject]): RepoWipCommit => ({ branch: branch.name, sha, subject, at }));
  });
  // A later attempt built on a partial branch contains its wip commits too: each commit is listed once.
  const unique = new Map<string, RepoWipCommit>();
  for (const commit of perBranch.flat()) if (!unique.has(commit.sha)) unique.set(commit.sha, commit);
  return [...unique.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_WIP_COMMITS);
}

function conflictsOf(ctx: StudioContext, projectId: string): RepoConflict[] {
  return ctx.repos.events.page({ projectId, type: CONFLICT_EVENT, limit: MAX_CONFLICTS }).events
    .map((e) => ({ at: e.createdAt, message: e.message, taskId: e.taskId }));
}

// ------------------------------------------------------------------ overview

/**
 * `GET /api/v2/projects/:id/repo`. 404 for an unknown project; any git problem (missing folder, not a repository, a
 * failing command) becomes `error` with empty git lists. Conflicts come from the event log, so they are always listed.
 */
export async function repoOverview(ctx: StudioContext, projectId: string): Promise<RepoOverview> {
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw new ProjectError('Project not found', 404);
  const cwd = project.workspacePath;
  const overview: RepoOverview = {
    projectId, workspacePath: cwd, integrationPath: project.integrationPath, integrationBranch: project.integrationBranch,
    integrationHead: null, baseCommit: project.baseCommit, branches: [], worktrees: [], wipCommits: [],
    conflicts: conflictsOf(ctx, projectId), error: null,
  };
  if (!fs.existsSync(cwd)) return { ...overview, error: `The workspace folder is missing: ${cwd}` };
  try {
    if (!(await isGitRepo(cwd))) return { ...overview, error: `The workspace folder is not a git repository: ${cwd}` };
    const integrationHead = project.integrationBranch
      ? await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${project.integrationBranch}`], true) : '';
    const integration = integrationHead ? project.integrationBranch : null;
    const owners = ownersOf(ctx, projectId);
    const branches = await mapLimited(await branchNames(cwd, project), (name) => readBranch(cwd, project, integration, name, owners));
    const worktrees = await readWorktrees(cwd, owners);
    const wipCommits = await readWipCommits(cwd, integration, branches);
    return { ...overview, integrationHead: integrationHead || null, branches, worktrees, wipCommits };
  } catch (error) {
    return { ...overview, error: `Could not read the repository: ${errorText(error)}` };
  }
}
