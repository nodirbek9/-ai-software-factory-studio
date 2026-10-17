import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSensitivePath } from '../security/sensitiveFiles.ts';
import { childEnv, runProcess } from './processRunner.ts';

export class GitError extends Error {}

/** An always-empty hooks folder: repository hooks (pre-commit, post-merge, …) never run for studio git calls. */
const NO_HOOKS_DIR = path.join(os.tmpdir(), 'asf-no-git-hooks');
fs.mkdirSync(NO_HOOKS_DIR, { recursive: true });

const GIT_ENV = childEnv({
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'AI Software Factory Studio',
  GIT_AUTHOR_EMAIL: 'studio@localhost',
  GIT_COMMITTER_NAME: 'AI Software Factory Studio',
  GIT_COMMITTER_EMAIL: 'studio@localhost',
});

/**
 * The only git subcommands the studio ever runs. Destructive operations (push, reset, clean,
 * branch -D, rebase, checkout of user branches) are intentionally absent.
 */
const ALLOWED_SUBCOMMANDS = new Set(['init', 'add', 'commit', 'rev-parse', 'worktree', 'merge', 'diff', 'status', 'log', 'ls-files', 'show']);
const ALLOWED_WORKTREE_ACTIONS = new Set(['add', 'remove', 'prune', 'list']);

export async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  const sub = args[0];
  if (!ALLOWED_SUBCOMMANDS.has(sub)) throw new GitError(`git ${sub} is not permitted by the studio`);
  if (sub === 'worktree' && !ALLOWED_WORKTREE_ACTIONS.has(args[1])) throw new GitError(`git worktree ${args[1]} is not permitted`);
  if (sub === 'merge' && args.includes('--abort') === false && !args.includes('--no-ff')) {
    throw new GitError('merges must use --no-ff');
  }
  // A repository's own config must not run programs on a read: no external diff drivers or textconv filters (P7-S1),
  // no fsmonitor hook on status/diff.
  const safeArgs = sub === 'diff' || sub === 'show' ? [sub, '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  const result = await runProcess('git', {
    cwd,
    args: ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true', '-c', `core.hooksPath=${NO_HOOKS_DIR}`,
      '-c', 'core.fsmonitor=false', ...safeArgs],
    env: GIT_ENV,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new GitError(`git ${args.join(' ')} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return result.stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'], true)) === 'true';
  } catch {
    return false;
  }
}

export function headCommit(dir: string): Promise<string> {
  return git(dir, ['rev-parse', 'HEAD']);
}

const NEVER_COMMIT = ['.asf-agy-task-*', '**/node_modules/**', '**/.npm-cache/**', '**/.pnpm-store/**', '**/.yarn/cache/**'];

/** Stages everything and commits; returns the commit hash, or null when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  // Secret-holding files (.env, keys) that are new or changed are left out; already-committed versions stay as they are.
  const changed = await git(dir, ['ls-files', '-z', '--others', '--modified', '--exclude-standard']);
  const secrets = [...new Set(changed.split('\0').filter((file) => file && isSensitivePath(file)))];
  // Agent scratch files and package-manager caches/installs (agents may run npm install) are never committed.
  await git(dir, ['add', '-A', '--', '.', ...NEVER_COMMIT.map((p) => `:(exclude,glob)${p}`),
    ...secrets.map((file) => `:(exclude,literal)${file}`)]);
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  await git(dir, ['commit', '-q', '-m', message]);
  return headCommit(dir);
}

export async function changedFiles(dir: string, from: string, to = 'HEAD'): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', `${from}..${to}`]);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}
