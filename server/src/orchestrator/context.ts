import type { Project, StudioSettings, Task } from '@asf/shared';
import type { AgentExecutor } from '../agents/agentExecutor.ts';
import type { AppConfig } from '../config.ts';
import type { Repositories } from '../db/repositories.ts';
import type { EventStream } from '../events/eventStream.ts';
import { DEFAULT_FALLBACK_ORDER, type ProviderRegistry } from '../providers/registry.ts';
import type { WorkspaceManager } from '../workspace/workspaceManager.ts';

export const DEFAULT_SETTINGS: StudioSettings = {
  maxParallelTasks: 2,
  defaultMaxAttempts: 2,
  taskTimeoutMinutes: 120,
  idleTimeoutMinutes: 15,
  fallbackOrder: DEFAULT_FALLBACK_ORDER,
  maxFixRounds: 2,
};

/** Serialises async work per key (used to guard each project's integration worktree). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

export interface StudioContext {
  config: AppConfig;
  repos: Repositories;
  events: EventStream;
  registry: ProviderRegistry;
  workspace: WorkspaceManager;
  executor: AgentExecutor;
  integrationLock: KeyedMutex;
}

export function getSettings(ctx: StudioContext): StudioSettings {
  return { ...DEFAULT_SETTINGS, ...ctx.repos.config.getSetting<Partial<StudioSettings>>('studio', {}) };
}

export function emitTask(ctx: StudioContext, task: Task, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'task.updated', level, message, data: { task } });
}

export function emitProject(ctx: StudioContext, project: Project, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  ctx.events.emit({ projectId: project.id, type: 'project.updated', level, message, data: { project } });
}
