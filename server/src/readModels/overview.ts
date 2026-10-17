import { AGENT_ROLES, type AgentRole, type OverviewAgentHealth, type OverviewProject, type OverviewResponse, type OverviewStage,
  type Project, type ProjectStatus, type Task, type TaskStatus } from '@asf/shared';
import { getSettings, type StudioContext } from '../orchestrator/context.ts';
import { recentFinished } from '../orchestrator/liveMonitor.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PROJECT: ReadonlySet<ProjectStatus> = new Set(['planning', 'running', 'awaiting_approval', 'paused']);
const FINISHED_TASK: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);
const STAGE_ROLES: AgentRole[] = ['architect', 'backend', 'frontend', 'qa', 'security', 'reviewer'];
const ACTIVE_PROJECTS_LIMIT = 6;
const RECENT_RUNS_LIMIT = 8;

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);
const finishedSince = (task: Task, since: number): boolean => ms(task.finishedAt) >= since;
/** Latest by finishedAt (tasks without one never win). */
const latestFinished = (tasks: Task[]): Task | null =>
  tasks.reduce<Task | null>((best, t) => (t.finishedAt && (!best || ms(t.finishedAt) > ms(best.finishedAt)) ? t : best), null);

function stageStatus(tasks: Task[]): OverviewStage['status'] {
  if (!tasks.length) return 'none';
  if (tasks.some((t) => t.status === 'running')) return 'running';
  if (tasks.some((t) => t.status === 'waiting_approval')) return 'waiting';
  if (tasks.some((t) => t.status === 'failed')) return 'failed';
  if (tasks.some((t) => t.status === 'blocked')) return 'blocked';
  if (tasks.every((t) => t.status === 'completed')) return 'completed';
  return 'pending';
}

function buildStage(ctx: StudioContext, role: AgentRole, tasks: Task[], nowMs: number): OverviewStage {
  const current = tasks.find((t) => t.status === 'running') ?? tasks.find((t) => !FINISHED_TASK.has(t.status)) ?? tasks.at(-1) ?? null;
  const withProvider = [current, ...[...tasks].reverse()].find((t) => t?.providerId) ?? null;
  // A stage that never ran shows the provider it is assigned to.
  const config = tasks.length && !withProvider ? ctx.registry.agentConfig(role) : null;
  const durationMs = tasks.reduce((sum, t) => {
    const started = ms(t.startedAt);
    if (Number.isNaN(started)) return sum;
    if (t.status === 'running') return sum + Math.max(0, nowMs - started);
    const finished = ms(t.finishedAt);
    return Number.isNaN(finished) ? sum : sum + Math.max(0, finished - started);
  }, 0);
  return {
    role, status: stageStatus(tasks),
    tasksTotal: tasks.length, tasksCompleted: tasks.filter((t) => t.status === 'completed').length,
    currentTask: current ? { id: current.id, title: current.title, status: current.status } : null,
    providerId: withProvider?.providerId ?? config?.providerId ?? null,
    model: withProvider ? withProvider.model : (config?.model || null),
    durationMs,
    latestFiles: latestFinished(tasks.filter((t) => t.status === 'completed'))?.filesChanged ?? [],
    error: latestFinished(tasks.filter((t) => t.status === 'failed'))?.error ?? null,
  };
}

/** Latest activity of a project: its own updatedAt or the latest task update, whichever is newer. */
function lastUpdate(project: Project, tasks: Task[]): string {
  return tasks.reduce((latest, t) => (t.updatedAt > latest ? t.updatedAt : latest), project.updatedAt);
}

/** The Home page read model, built from persisted state plus the providers' cached detection. */
export async function buildOverview(ctx: StudioContext, projectId?: string, now = new Date()): Promise<OverviewResponse> {
  const { repos } = ctx;
  const nowMs = now.getTime();
  const projects = repos.projects.list();
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const tasksByProject = new Map(projects.map((p) => [p.id, repos.tasks.listByProject(p.id)]));
  const allTasks = [...tasksByProject.values()].flat();
  const isActive = (t: Task): boolean => ACTIVE_PROJECT.has(projectById.get(t.projectId)?.status ?? 'draft');
  const pendingApprovals = projects.reduce((n, p) => n + repos.approvals.listByProject(p.id).filter((a) => a.status === 'pending').length, 0);

  let currentProject: OverviewResponse['currentProject'] = null;
  const selected = projectId ? projectById.get(projectId) : undefined;
  if (selected) {
    const tasks = tasksByProject.get(selected.id) ?? [];
    currentProject = {
      id: selected.id, name: selected.name, status: selected.status,
      stages: STAGE_ROLES.map((role) => buildStage(ctx, role, tasks.filter((t) => t.role === role), nowMs)),
      progress: {
        total: tasks.length,
        completed: tasks.filter((t) => t.status === 'completed').length,
        running: tasks.filter((t) => t.status === 'running').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
      },
    };
  }

  // Cached detection of enabled providers only; a disabled provider makes its agents 'disconnected' anyway.
  const providers = new Map((await ctx.registry.statusList()).map((p) => [p.id, p]));
  const configs = new Map(repos.config.getAgentConfigs().map((c) => [c.role, c]));
  const agentHealth: OverviewAgentHealth[] = AGENT_ROLES.map((role) => {
    const config = configs.get(role) ?? ctx.registry.agentConfig(role);
    const provider = providers.get(config.providerId);
    const own = allTasks.filter((t) => t.role === role);
    const running = own.find((t) => t.status === 'running');
    // Blocked work only counts while its project is still active (stopped projects keep their last task states).
    const waiting = own.find((t) => (t.status === 'blocked' || t.status === 'waiting_approval') && isActive(t));
    const latest = latestFinished(own.filter((t) => t.kind !== 'gate'));
    const finished7d = own.filter((t) => t.kind !== 'gate' && (t.status === 'completed' || t.status === 'failed') && finishedSince(t, nowMs - 7 * DAY_MS));
    let status: OverviewAgentHealth['status'] = 'idle';
    if (running) status = 'running';
    else if (!provider || !provider.enabled || !provider.available) status = 'disconnected';
    else if (latest?.status === 'failed' && finishedSince(latest, nowMs - DAY_MS)) status = 'failed';
    else if (waiting) status = 'blocked';
    const shown = running ?? waiting ?? null;
    return {
      role, status,
      currentTask: shown ? { id: shown.id, title: shown.title, projectName: projectById.get(shown.projectId)?.name ?? 'Deleted project' } : null,
      lastActivityAt: own.reduce<string | null>((at, t) => (!at || t.updatedAt > at ? t.updatedAt : at), null),
      providerId: config.providerId, providerLabel: provider?.label ?? null, model: config.model, effort: config.effort,
      successRate7d: finished7d.length ? finished7d.filter((t) => t.status === 'completed').length / finished7d.length : null,
      finished7d: finished7d.length,
    };
  });

  const activeProjects: OverviewProject[] = projects
    .map((p) => ({ project: p, tasks: tasksByProject.get(p.id) ?? [], updatedAt: lastUpdate(p, tasksByProject.get(p.id) ?? []) }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ACTIVE_PROJECTS_LIMIT)
    .map(({ project: p, tasks, updatedAt }) => ({
      id: p.id, name: p.name, description: p.description, status: p.status, workspacePath: p.workspacePath,
      integrationBranch: p.integrationBranch, updatedAt,
      tasksTotal: tasks.length, tasksCompleted: tasks.filter((t) => t.status === 'completed').length,
      activeAgents: tasks.filter((t) => t.status === 'running').length, failedTasks: tasks.filter((t) => t.status === 'failed').length,
    }));

  return {
    generatedAt: now.toISOString(),
    projects: {
      total: projects.length,
      active: projects.filter((p) => ACTIVE_PROJECT.has(p.status)).length,
      createdLast7d: projects.filter((p) => ms(p.createdAt) >= nowMs - 7 * DAY_MS).length,
    },
    agents: {
      running: allTasks.filter((t) => t.status === 'running').length,
      slots: getSettings(ctx).maxParallelTasks,
      queued: allTasks.filter((t) => t.status === 'ready' && t.kind !== 'gate' && isActive(t)).length,
    },
    tasks: {
      open: allTasks.filter((t) => !FINISHED_TASK.has(t.status)).length,
      failedLast24h: allTasks.filter((t) => t.status === 'failed' && finishedSince(t, nowMs - DAY_MS)).length,
      completedLast24h: allTasks.filter((t) => t.status === 'completed' && finishedSince(t, nowMs - DAY_MS)).length,
    },
    approvals: { pending: pendingApprovals },
    currentProject,
    agentHealth,
    activeProjects,
    recentRuns: recentFinished(ctx, RECENT_RUNS_LIMIT, (id) => projectById.get(id)?.name ?? 'Deleted project'),
  };
}
