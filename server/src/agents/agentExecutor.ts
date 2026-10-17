import type { AgentRole, EffortLevel, Project, SessionContinuity, Task, UsageInfo } from '@asf/shared';
import type { Repositories } from '../db/repositories.ts';
import type { EventStream } from '../events/eventStream.ts';
import type { ProviderRegistry, ResolvedProvider } from '../providers/registry.ts';
import { ProviderError, ProviderLimitError, type ProviderAdapter, type RunMode } from '../providers/types.ts';
import { redact } from '../security/redact.ts';
import { ROLE_SYSTEM_PROMPTS } from './prompts.ts';

export interface AgentRunInput {
  project: Project;
  task: Task | null;
  role: AgentRole;
  /**
   * Builds the prompt once the provider is known (file protocol vs. direct edits). For sessions, `nativeResume`
   * says whether the provider will continue its own session (send only the new message) or needs a context replay.
   */
  prompt: (editsFiles: boolean, continuity?: { nativeResume: boolean }) => string;
  cwd: string;
  mode: RunMode;
  signal: AbortSignal;
  /** Hard cap for the whole turn. */
  timeoutMs: number;
  /** Stop the turn after this long without any activity (only for adapters that report activity). */
  idleTimeoutMs?: number;
  fallbackOrder: string[];
  /** Workspace sessions name their provider directly instead of using the role's configuration. */
  explicit?: { providerId: string; model: string; effort: EffortLevel; allowFallback: boolean };
  /** Workspace session id: tags events and usage, and lets CLI providers keep a native session. */
  sessionId?: string;
  /** The provider session reference returned by the session's previous turn (null/absent on the first turn). */
  resumeRef?: string | null;
  /** Id for a NEW native CLI session (Claude `--session-id`, a UUID) when there is nothing to resume; defaults to `sessionId`. */
  providerSessionId?: string;
  /** Raw activity lines, in addition to the batched `agent.output` events. */
  onOutput?: (chunk: string) => void;
}

export interface AgentRunOutput {
  text: string;
  usage: UsageInfo | null;
  providerId: string;
  model: string;
  editsFiles: boolean;
  /** The provider's resumable session reference for the next turn (sessions only), or null. */
  sessionRef: string | null;
  /** 'native' when the provider keeps the conversation itself; 'replay' when the caller must resend context. */
  continuity: SessionContinuity;
}

const OUTPUT_FLUSH_MS = 750;
const OUTPUT_EVENT_MAX = 2000;
const IDLE_CHECK_MS = 10_000;

/** Runs one agent turn through the routed provider, streaming output and recording usage. */
export class AgentExecutor {
  constructor(private readonly registry: ProviderRegistry, private readonly repos: Repositories, private readonly events: EventStream) {}

  /**
   * Routes the turn to a usable provider. When a provider reports that its usage limit is used up, it is
   * parked until its reset time and the same turn moves on to the next provider in the routing order
   * (for an explicit provider only when its fallback is allowed).
   */
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const limitedThisRun = new Set<string>();
    for (;;) {
      const resolved = input.explicit
        ? await this.registry.resolveExplicit(input.explicit.providerId, input.explicit.model, input.explicit.effort,
          input.explicit.allowFallback, input.fallbackOrder)
        : await this.registry.resolveForRole(input.role, input.fallbackOrder);
      try {
        return await this.runOnce(input, resolved);
      } catch (error) {
        const id = resolved.adapter.id;
        if (!(error instanceof ProviderLimitError) || limitedThisRun.has(id) || input.signal.aborted) throw error;
        limitedThisRun.add(id);
        this.registry.markLimited(id, error.resetsAt, error.message);
        if (input.explicit && !input.explicit.allowFallback) throw error;
        const at = error.resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.events.emit({ projectId: input.project.id, taskId: input.task?.id, role: input.role, type: 'provider.limit', level: 'warn',
          message: `${resolved.adapter.label} hit its usage limit (usable again at ${at}); trying the next provider`,
          data: { providerId: id, resetsAt: error.resetsAt.toISOString(), ...this.sessionTag(input) } });
      }
    }
  }

  private sessionTag(input: AgentRunInput): { sessionId?: string } {
    return input.sessionId ? { sessionId: input.sessionId } : {};
  }

  /** Whether the adapter can resume its own session: declared, checked at runtime, or null when it does not say. */
  private async nativeResume(adapter: ProviderAdapter, settings: Record<string, string>): Promise<boolean | null> {
    if (adapter.supports?.resume) return adapter.supports.resume === 'native';
    if (!adapter.resumeSupported) return null;
    return adapter.resumeSupported(settings).catch(() => false);
  }

  private async runOnce(input: AgentRunInput, resolved: ResolvedProvider): Promise<AgentRunOutput> {
    const { project, task, role } = input;
    const { adapter, model, effort } = resolved;
    const tag = this.sessionTag(input);
    const data = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...extra, ...tag });
    if (resolved.fallbackFrom) {
      this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'provider.fallback', level: 'warn',
        message: `Routing ${role} to ${adapter.label} (assigned provider ${resolved.fallbackFrom} is not usable)`,
        ...(input.sessionId ? { data: data({ providerId: adapter.id, fallbackFrom: resolved.fallbackFrom }) } : {}) });
    }
    // A provider session reference only means something to the provider that created it, so a fallback starts fresh.
    const sameProvider = !input.explicit || input.explicit.providerId === adapter.id;
    const session = input.sessionId
      ? { id: input.providerSessionId ?? input.sessionId, resumeRef: sameProvider ? input.resumeRef ?? null : null } : undefined;
    const native = session ? await this.nativeResume(adapter, resolved.settings) : null;
    if (task) this.repos.tasks.update(task.id, { providerId: adapter.id, model });
    this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'agent.started',
      message: `${adapter.label}${adapter.isAi ? '' : ' [not AI]'} · ${model}${effort ? ` · effort ${effort}` : ''} · ${input.mode}`,
      data: data({ providerId: adapter.id, model, effort }) });

    let buffer = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      timer = null;
      if (!buffer) return;
      const chunk = buffer.length > OUTPUT_EVENT_MAX ? `…${buffer.slice(-OUTPUT_EVENT_MAX)}` : buffer;
      buffer = '';
      this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'agent.output', level: 'debug', message: redact(chunk),
        ...(input.sessionId ? { data: data({}) } : {}) });
    };

    // Idle watchdog: an agent that keeps producing activity is never stopped early; only silence is.
    const local = new AbortController();
    const onParentAbort = (): void => local.abort();
    input.signal.addEventListener('abort', onParentAbort, { once: true });
    if (input.signal.aborted) local.abort();
    // Cancelled or shut down while waiting (worktree setup, process slot): never start an agent process for it.
    if (local.signal.aborted) {
      input.signal.removeEventListener('abort', onParentAbort);
      throw new ProviderError(`${adapter.label}: cancelled before the agent started`, false);
    }
    let lastActivity = Date.now();
    let idleStopped = false;
    const heartbeat = (): void => { lastActivity = Date.now(); };
    const watchdog = adapter.reportsActivity && input.idleTimeoutMs
      ? setInterval(() => {
        if (Date.now() - lastActivity < input.idleTimeoutMs!) return;
        idleStopped = true;
        local.abort();
      }, Math.min(IDLE_CHECK_MS, Math.max(50, input.idleTimeoutMs / 3)))
      : null;

    try {
      const result = await adapter.run({
        prompt: input.prompt(adapter.editsFiles, session ? { nativeResume: native === true && session.resumeRef !== null } : undefined),
        systemPrompt: ROLE_SYSTEM_PROMPTS[role],
        cwd: input.cwd,
        mode: input.mode,
        model,
        effort,
        timeoutMs: input.timeoutMs,
        signal: local.signal,
        task: task ? { key: task.key, kind: task.kind, role: task.role, attempt: task.attempt } : undefined,
        session,
        onHeartbeat: heartbeat,
        onOutput: (chunk) => {
          heartbeat();
          buffer += chunk;
          if (!timer) timer = setTimeout(flush, OUTPUT_FLUSH_MS);
          if (input.onOutput) {
            try { input.onOutput(chunk); } catch { /* a broken listener must never break the turn */ }
          }
        },
      }, resolved.settings).catch((error: unknown) => {
        if (idleStopped && !input.signal.aborted) {
          const minutes = Math.round(input.idleTimeoutMs! / 60_000);
          throw new ProviderError(`${adapter.label} showed no activity for ${minutes} min, so it was stopped (its work so far is kept for the next attempt)`);
        }
        throw error;
      });
      const actualModel = result.model ?? model;
      if (actualModel !== model) {
        if (task) this.repos.tasks.update(task.id, { model: actualModel });
        this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'agent.model', message: `${adapter.label} reports model ${actualModel} (requested ${model})`,
          data: data({ requested: model, actual: actualModel }) });
      }
      if (result.usage) {
        // Built as a variable so this compiles whether or not UsageRecord already declares the optional sessionId.
        const record = { projectId: project.id, taskId: task?.id ?? null, role, providerId: adapter.id, model: actualModel, usage: result.usage,
          sessionId: input.sessionId ?? null, runId: task?.runId ?? null };
        this.repos.usage.record(record);
      }
      const sessionRef = session ? result.sessionRef ?? null : null;
      // An adapter that says it cannot resume (Codex without `exec resume`) stays on replay even if it reports a ref;
      // one that says nothing counts as native when it hands back a ref. Task/chat runs persist nothing: replay.
      const continuity: SessionContinuity = session && (native ?? Boolean(sessionRef)) ? 'native' : 'replay';
      return { text: result.text, usage: result.usage, providerId: adapter.id, model: actualModel, editsFiles: adapter.editsFiles,
        sessionRef, continuity };
    } finally {
      if (watchdog) clearInterval(watchdog);
      input.signal.removeEventListener('abort', onParentAbort);
      if (timer) clearTimeout(timer);
      flush();
    }
  }
}
