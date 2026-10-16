import type { AgentRole, Project, Task, UsageInfo } from '@asf/shared';
import type { Repositories } from '../db/repositories.ts';
import type { EventStream } from '../events/eventStream.ts';
import type { ProviderRegistry, ResolvedProvider } from '../providers/registry.ts';
import { ProviderError, ProviderLimitError, type RunMode } from '../providers/types.ts';
import { redact } from '../security/redact.ts';
import { ROLE_SYSTEM_PROMPTS } from './prompts.ts';

export interface AgentRunInput {
  project: Project;
  task: Task | null;
  role: AgentRole;
  /** Builds the prompt once the provider is known (file protocol vs. direct edits). */
  prompt: (editsFiles: boolean) => string;
  cwd: string;
  mode: RunMode;
  signal: AbortSignal;
  /** Hard cap for the whole turn. */
  timeoutMs: number;
  /** Stop the turn after this long without any activity (only for adapters that report activity). */
  idleTimeoutMs?: number;
  fallbackOrder: string[];
}

export interface AgentRunOutput {
  text: string;
  usage: UsageInfo | null;
  providerId: string;
  model: string;
  editsFiles: boolean;
}

const OUTPUT_FLUSH_MS = 750;
const OUTPUT_EVENT_MAX = 2000;
const IDLE_CHECK_MS = 10_000;

/** Runs one agent turn through the routed provider, streaming output and recording usage. */
export class AgentExecutor {
  constructor(private readonly registry: ProviderRegistry, private readonly repos: Repositories, private readonly events: EventStream) {}

  /**
   * Routes the turn to a usable provider. When a provider reports that its usage limit is used up, it is
   * parked until its reset time and the same turn moves on to the next provider in the routing order.
   */
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const limitedThisRun = new Set<string>();
    for (;;) {
      const resolved = await this.registry.resolveForRole(input.role, input.fallbackOrder);
      try {
        return await this.runOnce(input, resolved);
      } catch (error) {
        const id = resolved.adapter.id;
        if (!(error instanceof ProviderLimitError) || limitedThisRun.has(id) || input.signal.aborted) throw error;
        limitedThisRun.add(id);
        this.registry.markLimited(id, error.resetsAt, error.message);
        const at = error.resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.events.emit({ projectId: input.project.id, taskId: input.task?.id, role: input.role, type: 'provider.limit', level: 'warn',
          message: `${resolved.adapter.label} hit its usage limit (usable again at ${at}); trying the next provider`,
          data: { providerId: id, resetsAt: error.resetsAt.toISOString() } });
      }
    }
  }

  private async runOnce(input: AgentRunInput, resolved: ResolvedProvider): Promise<AgentRunOutput> {
    const { project, task, role } = input;
    const { adapter, model, effort } = resolved;
    if (resolved.fallbackFrom) {
      this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'provider.fallback', level: 'warn',
        message: `Routing ${role} to ${adapter.label} (assigned provider ${resolved.fallbackFrom} is not usable)` });
    }
    if (task) this.repos.tasks.update(task.id, { providerId: adapter.id, model });
    this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'agent.started',
      message: `${adapter.label}${adapter.isAi ? '' : ' [not AI]'} · ${model}${effort ? ` · effort ${effort}` : ''} · ${input.mode}`, data: { providerId: adapter.id, model, effort } });

    let buffer = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      timer = null;
      if (!buffer) return;
      const chunk = buffer.length > OUTPUT_EVENT_MAX ? `…${buffer.slice(-OUTPUT_EVENT_MAX)}` : buffer;
      buffer = '';
      this.events.emit({ projectId: project.id, taskId: task?.id, role, type: 'agent.output', level: 'debug', message: redact(chunk) });
    };

    // Idle watchdog: an agent that keeps producing activity is never stopped early; only silence is.
    const local = new AbortController();
    const onParentAbort = (): void => local.abort();
    input.signal.addEventListener('abort', onParentAbort, { once: true });
    if (input.signal.aborted) local.abort();
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
        prompt: input.prompt(adapter.editsFiles),
        systemPrompt: ROLE_SYSTEM_PROMPTS[role],
        cwd: input.cwd,
        mode: input.mode,
        model,
        effort,
        timeoutMs: input.timeoutMs,
        signal: local.signal,
        task: task ? { key: task.key, kind: task.kind, role: task.role, attempt: task.attempt } : undefined,
        onHeartbeat: heartbeat,
        onOutput: (chunk) => {
          heartbeat();
          buffer += chunk;
          if (!timer) timer = setTimeout(flush, OUTPUT_FLUSH_MS);
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
          data: { requested: model, actual: actualModel } });
      }
      if (result.usage) {
        this.repos.usage.record({ projectId: project.id, taskId: task?.id ?? null, role, providerId: adapter.id, model: actualModel, usage: result.usage });
      }
      return { text: result.text, usage: result.usage, providerId: adapter.id, model: actualModel, editsFiles: adapter.editsFiles };
    } finally {
      if (watchdog) clearInterval(watchdog);
      input.signal.removeEventListener('abort', onParentAbort);
      if (timer) clearTimeout(timer);
      flush();
    }
  }
}
