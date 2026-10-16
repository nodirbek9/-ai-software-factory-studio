import type { AgentRole, EventLevel, StudioEvent } from '@asf/shared';
import type { EventRepository } from '../db/repositories.ts';
import { redact, redactDeep } from '../security/redact.ts';

export interface EmitInput {
  projectId?: string | null;
  taskId?: string | null;
  role?: AgentRole | null;
  type: string;
  level?: EventLevel;
  message: string;
  data?: Record<string, unknown> | null;
}

type Listener = (event: StudioEvent) => void;

/** Persists every event (with secrets redacted) and fans it out to live subscribers (SSE clients). */
export class EventStream {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly repo: EventRepository) {}

  emit(input: EmitInput): StudioEvent {
    const event = this.repo.insert({
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      role: input.role ?? null,
      type: input.type,
      level: input.level ?? 'info',
      message: redact(input.message),
      data: input.data ? redactDeep(input.data) : null,
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the orchestrator.
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Number of live subscribers (SSE clients). */
  get clientCount(): number {
    return this.listeners.size;
  }

  replay(afterId: number, projectId?: string): StudioEvent[] {
    return this.repo.list({ afterId, projectId, limit: 1000 });
  }
}
