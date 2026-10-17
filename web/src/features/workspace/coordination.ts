import type { AgentRole, StudioEvent, Task } from '@asf/shared';

// Pure derivations for the coordination drawer (AGENT_WORKSPACE_SPEC.md §11). No fetching, no store access.

export interface Handoff {
  id: string;
  from: Pick<Task, 'id' | 'role' | 'title'>;
  to: Pick<Task, 'id' | 'role' | 'title' | 'status'>;
  /** When the receiving task started. */
  at: string;
}

const isTask = (value: unknown): value is Task =>
  typeof value === 'object' && value !== null && typeof (value as Task).id === 'string' && typeof (value as Task).key === 'string';

/** Latest known state of every task: the snapshot, overridden by newer `task.updated`-style events carrying `data.task`. */
export function latestTasks(snapshotTasks: Task[], events: StudioEvent[], projectId: string | null): Task[] {
  const byId = new Map<string, Task>();
  for (const task of snapshotTasks) byId.set(task.id, task);
  for (const event of events) {
    const task = event.data?.task;
    if (isTask(task) && (!projectId || task.projectId === projectId)) {
      const known = byId.get(task.id);
      if (!known || Date.parse(task.updatedAt) >= Date.parse(known.updatedAt)) byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

/**
 * Handoff = task B has started (or finished) after a task A it depends on completed:
 * "A.role → B.role · A.title · time". Newest first.
 */
export function deriveHandoffs(tasks: Task[]): Handoff[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const handoffs: Handoff[] = [];
  for (const to of tasks) {
    if (!to.startedAt) continue;
    for (const key of to.dependsOn) {
      const from = byKey.get(key);
      if (!from || from.status !== 'completed' || !from.finishedAt) continue;
      if (Date.parse(from.finishedAt) > Date.parse(to.startedAt)) continue;
      handoffs.push({
        id: `${from.id}>${to.id}`,
        from: { id: from.id, role: from.role, title: from.title },
        to: { id: to.id, role: to.role, title: to.title, status: to.status },
        at: to.startedAt,
      });
    }
  }
  return handoffs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface SharedArtifact {
  path: string;
  taskId: string | null;
  role: AgentRole | null;
  at: string;
}

/** Files of the project's `git.merge` events, newest merge first; a file merged twice is listed once. */
export function deriveArtifacts(events: StudioEvent[], projectId: string | null): SharedArtifact[] {
  const seen = new Set<string>();
  const out: SharedArtifact[] = [];
  for (const event of [...events].reverse()) {
    if (event.type !== 'git.merge' || event.projectId !== projectId) continue;
    const files = event.data?.files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file !== 'string' || seen.has(file)) continue;
      seen.add(file);
      out.push({ path: file, taskId: event.taskId, role: event.role, at: event.createdAt });
    }
  }
  return out;
}
