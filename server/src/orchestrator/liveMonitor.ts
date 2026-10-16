import type { LiveAgent, LiveFinished, LiveProvider, LiveQueued, LiveSnapshot, Project, Task } from '@asf/shared';
import { getSettings, type StudioContext } from './context.ts';

const RECENT_LIMIT = 12;
const OUTPUT_PREVIEW = 220;

function startOfToday(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Last non-empty line of an agent's streamed output, trimmed for a one-line preview. */
function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.at(-1) ?? '';
  return line.length > OUTPUT_PREVIEW ? `${line.slice(0, OUTPUT_PREVIEW)}…` : line;
}

/** Everything the live monitor shows, across all projects, built from persisted state only. */
export async function buildLiveSnapshot(ctx: StudioContext): Promise<LiveSnapshot> {
  const { repos } = ctx;
  const projects = new Map<string, Project>(repos.projects.list().map((p) => [p.id, p]));
  const providers = await ctx.registry.list();
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const projectName = (id: string): string => projects.get(id)?.name ?? 'Deleted project';

  const runningTasks = repos.tasks.listByStatus('running');
  const running: LiveAgent[] = runningTasks.map((task) => {
    const started = repos.events.latestForTask(task.id, 'agent.started');
    const fallback = repos.events.latestForTask(task.id, 'provider.fallback');
    const output = repos.events.latestForTask(task.id, 'agent.output');
    const data = (started?.data ?? {}) as { providerId?: string; model?: string; effort?: string };
    const providerId = task.providerId ?? data.providerId ?? null;
    const provider = providerId ? providerById.get(providerId) : undefined;
    // The executor emits provider.fallback synchronously right before agent.started for the same run.
    const fellBack = Boolean(fallback && started && fallback.id === started.id - 1);
    return {
      taskId: task.id, projectId: task.projectId, projectName: projectName(task.projectId), role: task.role, taskKey: task.key,
      taskTitle: task.title, kind: task.kind, providerId, providerLabel: provider?.label ?? providerId, model: task.model ?? data.model ?? null,
      effort: data.effort || null, isAi: provider?.isAi ?? true,
      fallbackFrom: fellBack && fallback ? (/assigned provider (\S+)/.exec(fallback.message)?.[1] ?? null) : null,
      startedAt: task.startedAt, attempt: task.attempt, maxAttempts: task.maxAttempts, checkpoint: task.checkpoint,
      lastOutput: output ? lastLine(output.message) : null, lastOutputAt: output?.createdAt ?? null,
    };
  });

  const queued: LiveQueued[] = [...repos.tasks.listByStatus('ready'), ...repos.tasks.listByStatus('waiting_approval')]
    .filter((t) => ['planning', 'running', 'awaiting_approval'].includes(projects.get(t.projectId)?.status ?? ''))
    .map((t: Task) => ({ taskId: t.id, projectId: t.projectId, projectName: projectName(t.projectId), role: t.role, taskTitle: t.title, status: t.status }));

  const today = repos.usage.sinceByProvider(startOfToday());
  const liveProviders: LiveProvider[] = providers.map((p) => ({
    id: p.id, label: p.label, enabled: p.enabled, available: p.available, isAi: p.isAi,
    running: running.filter((r) => r.providerId === p.id).length,
    limitedUntil: p.limitedUntil,
    callsToday: today.get(p.id)?.calls ?? 0, tokensToday: today.get(p.id)?.tokens ?? 0, costToday: today.get(p.id)?.cost ?? 0,
  }));

  const recent: LiveFinished[] = repos.tasks.listRecentlyFinished(RECENT_LIMIT).map((t) => {
    const started = repos.events.latestForTask(t.id, 'agent.started');
    const effort = (started?.data as { effort?: string } | null)?.effort || null;
    return {
      taskId: t.id, projectId: t.projectId, projectName: projectName(t.projectId), role: t.role, taskTitle: t.title, status: t.status,
      providerId: t.providerId, model: t.model, effort,
      durationMs: t.startedAt && t.finishedAt ? Date.parse(t.finishedAt) - Date.parse(t.startedAt) : null,
      finishedAt: t.finishedAt!, error: t.error,
    };
  });

  return { generatedAt: new Date().toISOString(), maxParallel: getSettings(ctx).maxParallelTasks, running, queued, providers: liveProviders, recent };
}
