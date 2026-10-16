import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Project, Task } from '@asf/shared';
import { APP_ROOT } from '../src/config.ts';
import { createStudio, type Studio } from '../src/app.ts';

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `asf-${prefix}-`));
}

/** Copies the bundled samples into a temp folder, optionally patching the replay script. */
export function prepareSamples(patch?: (script: Record<string, any>) => void, name = 'todo-service'): string {
  const dir = tempDir('samples');
  const target = path.join(dir, name);
  fs.cpSync(path.join(APP_ROOT, 'sample-projects', 'todo-service'), target, { recursive: true });
  const file = path.join(target, '.asf-script.json');
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const entry of Object.values<Record<string, unknown>>(script.tasks)) entry.delayMs = 200;
  patch?.(script);
  fs.writeFileSync(file, JSON.stringify(script));
  return dir;
}

export async function startStudio(dataDir: string, samplesDir: string): Promise<Studio> {
  return createStudio({ dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'workspaces'),
    worktreesDir: path.join(dataDir, 'worktrees'), samplesDir, webDistDir: path.join(dataDir, 'no-web'), approvedRoots: [] });
}

export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 90_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function projectOf(studio: Studio, id: string): Project {
  return studio.ctx.repos.projects.get(id)!;
}

export function taskByKey(studio: Studio, projectId: string, key: string): Task | undefined {
  return studio.ctx.repos.tasks.listByProject(projectId).find((t) => t.key === key);
}

export async function approvePlan(studio: Studio, projectId: string): Promise<void> {
  const approval = await waitFor(() => studio.ctx.repos.approvals.listByProject(projectId).find((a) => a.kind === 'plan' && a.status === 'pending'),
    60_000, 'plan approval');
  studio.projects.decideApproval(approval.id, 'approved', 'looks good');
}
