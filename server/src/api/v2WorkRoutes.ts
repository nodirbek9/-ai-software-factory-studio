import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ROLES, type RepoOverview, type TaskDetail, type TaskDiff, type TasksResponse, type TaskStatus } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { repoOverview } from '../readModels/repoReadModel.ts';
import { listTasks, taskDetail, taskDiff } from '../readModels/tasksReadModel.ts';
import { installScriptsAllowed, setInstallScriptsAllowed } from '../security/installScripts.ts';

// Phase 5 read routes: tasks across projects, the task drawer and diff, and a project's git overview (PHASE_5.md).
// Registered after registerRoutes, so its security hooks and error handler apply.

/** `?x=` (empty) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'blocked', 'cancelled'] as const satisfies readonly TaskStatus[];

const tasksQuery = z.object({
  projectId: optional(z.string().uuid()),
  /** 'active' (default), 'all' or a run id (UUID or a backfill id run-<projectId>). */
  runId: optional(z.string().min(1).max(100)),
  role: optional(z.enum(AGENT_ROLES)),
  status: optional(z.enum(TASK_STATUSES)),
  q: optional(z.string().max(200)),
  limit: optional(z.coerce.number().int().min(1).max(2000)),
});
const taskParam = z.object({ id: z.string().min(1).max(100) });
const projectParam = z.object({ id: z.string().uuid() });
const installScriptsBody = z.object({ allowed: z.boolean(), confirm: z.literal(true) });

export interface V2WorkRouteDeps {
  ctx: StudioContext;
}

export function registerV2WorkRoutes(app: FastifyInstance, { ctx }: V2WorkRouteDeps): void {
  app.get('/api/v2/tasks', async (request): Promise<TasksResponse> => listTasks(ctx, tasksQuery.parse(request.query)));
  app.get('/api/v2/tasks/:id', async (request): Promise<TaskDetail> => taskDetail(ctx, taskParam.parse(request.params).id));
  app.get('/api/v2/tasks/:id/diff', async (request): Promise<TaskDiff> => taskDiff(ctx, taskParam.parse(request.params).id));
  app.get('/api/v2/projects/:id/repo', async (request): Promise<RepoOverview> => repoOverview(ctx, projectParam.parse(request.params).id));

  // P7-S8: package install scripts are off (--ignore-scripts) until the owner allows them for a project.
  const requireProject = (params: unknown): string => {
    const { id } = projectParam.parse(params);
    if (!ctx.repos.projects.get(id)) throw new ProjectError('Project not found', 404);
    return id;
  };
  app.get('/api/v2/projects/:id/install-scripts', async (request): Promise<{ allowed: boolean }> =>
    ({ allowed: installScriptsAllowed(ctx, requireProject(request.params)) }));
  app.put('/api/v2/projects/:id/install-scripts', async (request): Promise<{ allowed: boolean }> => {
    const id = requireProject(request.params);
    const { allowed } = installScriptsBody.parse(request.body);
    setInstallScriptsAllowed(ctx, id, allowed);
    return { allowed };
  });
}
