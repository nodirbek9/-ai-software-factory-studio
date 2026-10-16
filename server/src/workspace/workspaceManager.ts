import fs from 'node:fs';
import path from 'node:path';
import type { DirListing, FileEntry, Project, Task } from '@asf/shared';
import type { AppConfig } from '../config.ts';
import { KeyedMutex } from '../orchestrator/context.ts';
import { isSensitivePath } from '../security/sensitiveFiles.ts';
import { commitAll, git, headCommit, isGitRepo } from './git.ts';

export { isSensitivePath };

export class WorkspaceError extends Error {}

/** Merging a task branch into the integration branch conflicted; the integration branch was left unchanged. */
export class MergeConflictError extends WorkspaceError {}

export interface FileEdit {
  path: string;
  content?: string;
  delete?: boolean;
}

const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 5000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', 'coverage']);
const MAX_COPY_FILES = 20_000;
const MAX_COPY_BYTES = 500 * 1024 * 1024;
const MAX_DIR_ENTRIES = 1000;
const HIDDEN_DIR_NAMES = new Set(['node_modules', 'system volume information', 'recovery', 'config.msi', 'windows.old']);

/** Counts files/bytes that a copy import would take (skipped folders excluded); stops early once over the limits. */
function measureTree(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) return;
      if (SKIPPED_DIRS.has(item.name) || item.isSymbolicLink()) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(root);
  return { files, bytes };
}

const SAFE_SEGMENT = /^[\w@.+-][\w@ .+-]*$/;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when any existing segment of root/segments is a symlink or junction that resolves outside root (or cannot be
 * resolved). Checking only the target or its parent misses `link/new/file` when `new` does not exist yet.
 */
function linkEscapes(realRoot: string, segments: string[]): boolean {
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return false; // the rest of the path does not exist yet, so nothing below can be a link
    }
    if (!stat.isSymbolicLink()) continue;
    try {
      if (!isInside(fs.realpathSync.native(current), realRoot)) return true;
    } catch {
      return true; // dangling link: refuse rather than guess where it points
    }
  }
  return false;
}

/** Refusal to read a secret-holding file (HTTP 403). */
export class SensitiveFileError extends Error {}

/** Owns every filesystem and git touch-point; nothing outside approved roots is ever read or written. */
export class WorkspaceManager {
  /** Serialises operations that touch shared repository metadata (.git/worktrees, refs). */
  private readonly repoLock = new KeyedMutex();

  /** Folders the user approved in the UI (persisted by the caller), on top of ASF_APPROVED_ROOTS. */
  private userRoots: string[] = [];

  constructor(private readonly config: AppConfig) {}

  get approvedRoots(): string[] {
    return [this.config.workspacesDir, this.config.worktreesDir, ...this.config.approvedRoots, ...this.userRoots];
  }

  get userApprovedRoots(): string[] {
    return [...this.userRoots];
  }

  setUserApprovedRoots(roots: string[]): void {
    this.userRoots = roots.filter((r) => path.isAbsolute(r) && !this.isProtected(r)).map((r) => path.resolve(r));
  }

  /** Approves a folder for import. Protected locations and non-directories are refused. */
  approveRoot(target: string): string[] {
    if (!path.isAbsolute(target)) throw new WorkspaceError('Choose an absolute folder path');
    const resolved = realpathOrSelf(path.resolve(target));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new WorkspaceError(`Not a directory: ${target}`);
    if (this.isProtected(resolved)) throw new WorkspaceError(`${resolved} is a protected location and cannot be approved`);
    if (!this.userRoots.some((r) => r.toLowerCase() === resolved.toLowerCase())) this.userRoots = [...this.userRoots, resolved];
    return this.userApprovedRoots;
  }

  revokeRoot(target: string): string[] {
    const resolved = path.resolve(target).toLowerCase();
    this.userRoots = this.userRoots.filter((r) => r.toLowerCase() !== resolved);
    return this.userApprovedRoots;
  }

  /** Inside a protected location (other tools, system folders, the studio itself). */
  isProtected(target: string): boolean {
    const resolved = realpathOrSelf(path.resolve(target));
    return this.config.protectedPaths.some((p) => isInside(resolved, realpathOrSelf(p)));
  }

  /** Approved, not protected, and not an ancestor of a protected location. */
  assertImportable(target: string): string {
    const resolved = this.assertApproved(target);
    if (this.isProtected(resolved)) throw new WorkspaceError(`${resolved} is a protected location and cannot be imported`);
    const contains = this.config.protectedPaths.find((p) => isInside(realpathOrSelf(p), resolved));
    if (contains) throw new WorkspaceError(`${resolved} contains the protected location ${contains}; choose a narrower folder`);
    return resolved;
  }

  assertApproved(target: string): string {
    const resolved = realpathOrSelf(path.resolve(target));
    const ok = this.approvedRoots.some((root) => isInside(resolved, realpathOrSelf(root)));
    if (!ok) throw new WorkspaceError(`Path is outside the approved workspaces: ${target}`);
    return resolved;
  }

  /** Resolves a project-relative path and guarantees it stays inside root (no "..", absolute paths, .git or symlink escape). */
  resolveInside(root: string, relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new WorkspaceError(`Invalid path: ${relativePath}`);
    const segments = normalized.split('/');
    if (segments.some((s) => s === '..' || s === '.' || s === '' || !SAFE_SEGMENT.test(s))) throw new WorkspaceError(`Invalid path: ${relativePath}`);
    if (segments[0].toLowerCase() === '.git') throw new WorkspaceError('Writing inside .git is not allowed');
    const realRoot = realpathOrSelf(root);
    const full = path.join(realRoot, ...segments);
    const existingParent = realpathOrSelf(fs.existsSync(full) ? full : path.dirname(full));
    if (!isInside(full, realRoot) || (fs.existsSync(existingParent) && !isInside(existingParent, realRoot))
      || linkEscapes(realRoot, segments)) {
      throw new WorkspaceError(`Path escapes the workspace: ${relativePath}`);
    }
    return full;
  }

  async createNewWorkspace(slug: string, spec: string): Promise<string> {
    const dir = path.join(this.config.workspacesDir, slug);
    if (fs.existsSync(dir)) throw new WorkspaceError(`Workspace already exists: ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SPEC.md'), spec.endsWith('\n') ? spec : `${spec}\n`);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    await this.initRepo(dir);
    return dir;
  }

  async createFromSample(slug: string, sampleName: string): Promise<string> {
    if (!SAFE_SEGMENT.test(sampleName) || sampleName.includes('..')) throw new WorkspaceError('Invalid sample name');
    const source = path.join(this.config.samplesDir, sampleName);
    if (!fs.existsSync(source)) throw new WorkspaceError(`Unknown sample project: ${sampleName}`);
    const dir = path.join(this.config.workspacesDir, slug);
    if (fs.existsSync(dir)) throw new WorkspaceError(`Workspace already exists: ${dir}`);
    fs.cpSync(source, dir, { recursive: true, filter: (src) => !src.split(path.sep).some((s) => SKIPPED_DIRS.has(s)) });
    await this.initRepo(dir);
    return dir;
  }

  /** Copies an approved folder into a fresh studio workspace; the original folder is never modified. */
  async importByCopy(slug: string, sourcePath: string): Promise<string> {
    const source = this.assertImportable(sourcePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new WorkspaceError(`Not a directory: ${sourcePath}`);
    const { files, bytes } = measureTree(source);
    if (files > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
      throw new WorkspaceError(`Folder is too large to copy (over ${MAX_COPY_FILES} files or ${MAX_COPY_BYTES / 1048576} MB, `
        + 'not counting node_modules, dist, build and .git). Choose a smaller folder or a git repository.');
    }
    const dir = path.join(this.config.workspacesDir, slug);
    if (fs.existsSync(dir)) throw new WorkspaceError(`Workspace already exists: ${dir}`);
    fs.cpSync(source, dir, {
      recursive: true,
      filter: (src) => !path.relative(source, src).split(path.sep).some((s) => SKIPPED_DIRS.has(s)) && !isSensitivePath(src),
    });
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    await this.initRepo(dir);
    return dir;
  }

  listDrives(): string[] {
    if (process.platform !== 'win32') return ['/'];
    return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`).filter((drive) => {
      try {
        return fs.statSync(drive).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** Lists sub-folders (names only) for the folder picker. Hidden, system and dependency folders are skipped. */
  listDirectory(target: string): DirListing {
    if (!path.isAbsolute(target)) throw new WorkspaceError('Choose an absolute folder path');
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new WorkspaceError(`Not a directory: ${target}`);
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      throw new WorkspaceError(`Cannot read ${resolved}`);
    }
    const dirs = items
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$') && !HIDDEN_DIR_NAMES.has(d.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const entries = dirs.slice(0, MAX_DIR_ENTRIES).map((d) => {
      const full = path.join(resolved, d.name);
      return { name: d.name, path: full, isGitRepo: fs.existsSync(path.join(full, '.git')) };
    });
    const parent = path.dirname(resolved);
    let approved = true;
    try {
      this.assertApproved(resolved);
    } catch {
      approved = false;
    }
    return {
      path: resolved, parent: parent === resolved ? null : parent, entries, isGitRepo: fs.existsSync(path.join(resolved, '.git')),
      approved, protected: this.isProtected(resolved), truncated: dirs.length > MAX_DIR_ENTRIES,
    };
  }

  listSamples(): string[] {
    if (!fs.existsSync(this.config.samplesDir)) return [];
    return fs.readdirSync(this.config.samplesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  }

  readSampleSpec(sampleName: string): string | null {
    if (!SAFE_SEGMENT.test(sampleName) || sampleName.includes('..')) return null;
    const file = path.join(this.config.samplesDir, sampleName, 'SPEC.md');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  async validateImport(repoPath: string): Promise<string> {
    const resolved = this.assertImportable(repoPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new WorkspaceError(`Not a directory: ${repoPath}`);
    if (!(await isGitRepo(resolved))) throw new WorkspaceError('The folder is not a git repository. Choose "Copy into the studio" to import it without git.');
    try {
      await headCommit(resolved);
    } catch {
      throw new WorkspaceError('The repository has no commits yet.');
    }
    return resolved;
  }

  /** Creates the studio-owned integration worktree; the user's own checkout is never modified. */
  async setupIntegration(project: Project): Promise<{ integrationPath: string; integrationBranch: string; baseCommit: string }> {
    const base = await headCommit(project.workspacePath);
    const integrationBranch = `asf/${project.slug}/integration`;
    const integrationPath = path.join(this.config.worktreesDir, project.id, 'integration');
    if (!fs.existsSync(integrationPath)) {
      fs.mkdirSync(path.dirname(integrationPath), { recursive: true });
      await git(project.workspacePath, ['worktree', 'add', '-b', integrationBranch, integrationPath, base]);
    }
    return { integrationPath, integrationBranch, baseCommit: base };
  }

  /** New worktree for one attempt; `continueFrom` (a branch with an interrupted attempt's work) is used as its base. */
  async createTaskWorktree(project: Project, task: Task, continueFrom?: string): Promise<{ worktreePath: string; branch: string }> {
    if (!project.integrationPath) throw new WorkspaceError('Project has no integration worktree');
    const name = `${task.key}-a${task.attempt}`;
    const branch = `asf/${project.slug}/${name}`;
    const worktreePath = path.join(this.config.worktreesDir, project.id, name);
    if (fs.existsSync(worktreePath)) await this.removeWorktree(project, worktreePath);
    const partialHead = continueFrom ? await git(project.workspacePath, ['rev-parse', '--verify', '--quiet', continueFrom], true) : '';
    const from = partialHead || await headCommit(project.integrationPath);
    await this.repoLock.run(project.workspacePath, () => git(project.workspacePath, ['worktree', 'add', '-b', branch, worktreePath, from]));
    return { worktreePath, branch };
  }

  async removeWorktree(project: Project, worktreePath: string): Promise<void> {
    if (!isInside(path.resolve(worktreePath), path.join(this.config.worktreesDir, project.id))) {
      throw new WorkspaceError('Refusing to remove a worktree the studio does not own');
    }
    await this.repoLock.run(project.workspacePath, async () => {
      await git(project.workspacePath, ['worktree', 'remove', '--force', worktreePath], true);
      if (!this.tryRemoveDir(worktreePath)) this.scheduleDirRemoval(worktreePath);
      await git(project.workspacePath, ['worktree', 'prune'], true);
    });
  }

  private tryRemoveDir(dir: string): boolean {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return !fs.existsSync(dir);
    } catch {
      return false;
    }
  }

  /** Windows antivirus/indexers can hold handles on a fresh tree for seconds; keep retrying in the background. */
  private scheduleDirRemoval(dir: string, attempt = 1): void {
    const MAX_ATTEMPTS = 6;
    const timer = setTimeout(() => {
      if (this.tryRemoveDir(dir)) return;
      if (attempt < MAX_ATTEMPTS) this.scheduleDirRemoval(dir, attempt + 1);
      else process.emitWarning(`Could not remove worktree directory ${dir}; delete it manually.`);
    }, 1000 * 2 ** attempt);
    timer.unref();
  }

  /**
   * Removes everything the studio created for a project: its worktrees and, when the workspace lives in the
   * studio's own workspaces folder (new / sample / copy), that folder. An imported repository is never deleted;
   * its asf/* branches stay for the user to remove (the studio never deletes branches).
   */
  async removeProjectFiles(project: Project): Promise<{ removedWorkspace: boolean }> {
    const projectWorktrees = path.join(this.config.worktreesDir, project.id);
    if (fs.existsSync(projectWorktrees)) {
      for (const name of fs.readdirSync(projectWorktrees)) await this.removeWorktree(project, path.join(projectWorktrees, name));
      if (!this.tryRemoveDir(projectWorktrees)) this.scheduleDirRemoval(projectWorktrees);
    }
    const ownsWorkspace = isInside(path.resolve(project.workspacePath), path.resolve(this.config.workspacesDir))
      && path.resolve(project.workspacePath) !== path.resolve(this.config.workspacesDir);
    // A just-cancelled process may still hold handles on Windows; finish the deletion in the background then.
    if (ownsWorkspace && !this.tryRemoveDir(project.workspacePath)) this.scheduleDirRemoval(project.workspacePath);
    return { removedWorkspace: ownsWorkspace };
  }

  /** Merges a task branch into the integration branch; aborts cleanly on conflict. */
  async mergeIntoIntegration(project: Project, branch: string, message: string): Promise<string> {
    const target = project.integrationPath!;
    try {
      await git(target, ['merge', '--no-ff', '-m', message, branch]);
    } catch (error) {
      await git(target, ['merge', '--abort'], true);
      throw new MergeConflictError(`Merge conflict while integrating ${branch}: ${(error as Error).message}`);
    }
    return headCommit(target);
  }

  commit(dir: string, message: string): Promise<string | null> {
    return commitAll(dir, message);
  }

  applyEdits(root: string, edits: FileEdit[]): string[] {
    const written: string[] = [];
    for (const edit of edits) {
      const full = this.resolveInside(root, edit.path);
      if (edit.delete) {
        if (fs.existsSync(full)) fs.rmSync(full, { force: true });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, edit.content ?? '');
      }
      written.push(edit.path.replace(/\\/g, '/'));
    }
    return written;
  }

  listFiles(root: string): FileEntry[] {
    const entries: FileEntry[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        if (SKIPPED_DIRS.has(item.name) || item.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          entries.push({ path: rel, type: 'dir', size: 0 });
          walk(full, rel);
        } else if (item.isFile()) {
          entries.push({ path: rel, type: 'file', size: fs.statSync(full).size });
        }
      }
    };
    if (fs.existsSync(root)) walk(root, '');
    return entries;
  }

  readFile(root: string, relativePath: string): { content: string; truncated: boolean; binary: boolean } {
    const full = this.resolveInside(root, relativePath);
    if (isSensitivePath(relativePath)) throw new SensitiveFileError(`${relativePath} may contain secrets, so the studio does not show it`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new WorkspaceError(`File not found: ${relativePath}`);
    const buffer = fs.readFileSync(full);
    const slice = buffer.subarray(0, MAX_READ_BYTES);
    if (slice.includes(0)) return { content: '', truncated: false, binary: true };
    return { content: slice.toString('utf8'), truncated: buffer.length > MAX_READ_BYTES, binary: false };
  }

  private async initRepo(dir: string): Promise<void> {
    await git(dir, ['init', '-q', '-b', 'main']);
    const commit = await commitAll(dir, 'chore: initial workspace (AI Software Factory Studio)');
    if (!commit) throw new WorkspaceError('Could not create the initial commit');
  }
}
