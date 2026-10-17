import type { ProcessBudgetOwner, ProcessBudgetSnapshot } from '@asf/shared';

/** Returns the slot to the budget; calling it again does nothing. */
export type ProcessSlotRelease = () => void;

interface Waiter {
  owner: ProcessBudgetOwner;
  since: string;
  resolve: (release: ProcessSlotRelease) => void;
  detach: () => void;
}

function abortError(): Error {
  const error = new Error('Aborted while waiting for a free agent process slot');
  error.name = 'AbortError';
  return error;
}

/**
 * Shared cap on CLI agent processes across scheduler tasks and workspace sessions (D-006). Waiters are served
 * first-come first-served; when tasks and sessions both wait, the kind that was served last yields to the other.
 */
export class ProcessBudget {
  private readonly running = new Set<ProcessBudgetOwner>();
  private queue: Waiter[] = [];
  private lastGranted: ProcessBudgetOwner['kind'] | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly getLimit: () => number) {}

  /** The limit currently in force (read from the setting on every call, so a change applies at the next acquire/release). */
  get limit(): number {
    const value = Math.floor(Number(this.getLimit()));
    return Number.isFinite(value) && value >= 1 ? value : 1;
  }

  acquire(owner: ProcessBudgetOwner, signal?: AbortSignal): Promise<ProcessSlotRelease> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<ProcessSlotRelease>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.detach();
        reject(abortError());
        this.notify();
      };
      const waiter: Waiter = {
        owner, since: new Date().toISOString(), resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
      this.notify();
    });
  }

  /** 1-based position of an owner that is waiting (1 = next to get a slot), or null when it is not queued. */
  queuePosition(owner: Pick<ProcessBudgetOwner, 'kind' | 'id'>): number | null {
    const order = this.serviceOrder();
    const index = order.findIndex((w) => w.owner.kind === owner.kind && w.owner.id === owner.id);
    return index < 0 ? null : index + 1;
  }

  snapshot(): ProcessBudgetSnapshot {
    return {
      limit: this.limit,
      running: [...this.running].map((owner) => ({ ...owner })),
      queued: this.serviceOrder().map((w, index) => ({ ...w.owner, position: index + 1, since: w.since })),
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The order in which the waiters would be served if slots kept freeing up. */
  private serviceOrder(): Waiter[] {
    const rest = [...this.queue];
    const order: Waiter[] = [];
    let last = this.lastGranted;
    while (rest.length) {
      const index = this.pickIndex(rest, last);
      const [next] = rest.splice(index, 1);
      order.push(next);
      last = next.owner.kind;
    }
    return order;
  }

  private pickIndex(waiters: Waiter[], last: ProcessBudgetOwner['kind'] | null): number {
    if (last === null) return 0;
    const other = waiters.findIndex((w) => w.owner.kind !== last);
    return other < 0 ? 0 : other;
  }

  private drain(): void {
    while (this.queue.length && this.running.size < this.limit) {
      const waiter = this.queue.splice(this.pickIndex(this.queue, this.lastGranted), 1)[0];
      waiter.detach();
      this.lastGranted = waiter.owner.kind;
      const slot = { ...waiter.owner };
      this.running.add(slot);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.running.delete(slot);
        this.drain();
        this.notify();
      });
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must never break the budget.
      }
    }
  }
}

/**
 * Calls `emit` with a fresh snapshot when the budget changes, at most once per `intervalMs`: the first change goes out
 * immediately, changes during the cool-down are merged into one trailing call. Returns a function that stops it.
 */
export function throttleBudgetUpdates(budget: ProcessBudget, emit: (snapshot: ProcessBudgetSnapshot) => void, intervalMs = 250): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let stopped = false;
  const cooldown = (): void => {
    timer = setTimeout(() => {
      timer = null;
      if (stopped || !dirty) return;
      dirty = false;
      emit(budget.snapshot());
      cooldown();
    }, intervalMs);
    timer.unref?.();
  };
  const unsubscribe = budget.onChange(() => {
    if (stopped) return;
    if (timer) { dirty = true; return; }
    emit(budget.snapshot());
    cooldown();
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
