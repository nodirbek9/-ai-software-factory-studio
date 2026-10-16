import type { TaskStatus } from '@asf/shared';

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'waiting_approval', 'pending', 'blocked', 'cancelled'],
  running: ['completed', 'failed', 'ready', 'cancelled'],
  waiting_approval: ['completed', 'failed', 'cancelled'],
  failed: ['ready', 'pending'], // pending: re-queued behind a fix task
  blocked: ['pending', 'cancelled'],
  cancelled: ['ready', 'pending'], // pending: a retry that still waits for its dependencies
  completed: [],
};

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

export class IllegalTransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`Illegal task transition ${from} -> ${to}`);
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
