import type { Task } from '@asf/shared';

/** Returns the keys forming a cycle, or null when the graph is a DAG. Unknown dependency keys are reported too. */
export function validateGraph(nodes: { key: string; dependsOn: string[] }[]): string | null {
  const keys = new Set(nodes.map((n) => n.key));
  if (keys.size !== nodes.length) return 'duplicate task keys';
  for (const node of nodes) {
    const unknown = node.dependsOn.find((d) => !keys.has(d));
    if (unknown) return `task "${node.key}" depends on unknown task "${unknown}"`;
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const visit = (key: string, trail: string[]): string | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return `dependency cycle: ${[...trail, key].join(' -> ')}`;
    state.set(key, 'visiting');
    for (const dep of byKey.get(key)!.dependsOn) {
      const cycle = visit(dep, [...trail, key]);
      if (cycle) return cycle;
    }
    state.set(key, 'done');
    return null;
  };
  for (const node of nodes) {
    const cycle = visit(node.key, []);
    if (cycle) return cycle;
  }
  return null;
}

/** Tasks whose every dependency is completed and that are waiting to start. */
export function dependenciesMet(task: Task, byKey: Map<string, Task>): boolean {
  return task.dependsOn.every((key) => byKey.get(key)?.status === 'completed');
}

export function dependencyFailed(task: Task, byKey: Map<string, Task>): boolean {
  return task.dependsOn.some((key) => {
    const status = byKey.get(key)?.status;
    return status === 'failed' || status === 'blocked' || status === 'cancelled';
  });
}

/** All tasks that (transitively) depend on the given key. */
export function dependantsOf(key: string, tasks: Task[]): Task[] {
  const result = new Map<string, Task>();
  const queue = [key];
  while (queue.length) {
    const current = queue.shift()!;
    for (const task of tasks) {
      if (task.dependsOn.includes(current) && !result.has(task.key)) {
        result.set(task.key, task);
        queue.push(task.key);
      }
    }
  }
  return [...result.values()];
}
