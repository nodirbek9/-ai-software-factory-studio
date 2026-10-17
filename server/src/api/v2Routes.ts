import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ROLES, EFFORT_LEVELS } from '@asf/shared';
import type {
  EventsPage, OverviewResponse, ProcessBudgetSnapshot, SystemHealth, UsageDailyResponse, UsageSummary, WorkspaceLayout, WorkspaceLayoutNode,
} from '@asf/shared';
import type { EventStream } from '../events/eventStream.ts';
import type { StudioContext } from '../orchestrator/context.ts';
import { ProjectError } from '../orchestrator/projectService.ts';
import { buildSystemHealth } from '../readModels/health.ts';
import { buildOverview } from '../readModels/overview.ts';
import { queryEvents } from '../readModels/logs.ts';
import { buildUsageSummary, DEFAULT_USAGE_DAYS, MAX_USAGE_DAYS, usageDaily } from '../readModels/usage.ts';

/** `?x=` (empty) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const overviewQuery = z.object({ projectId: optional(z.string().uuid()) });
const usageQuery = z.object({ range: optional(z.enum(['24h', '7d'])).transform((range) => range ?? '24h') });
const isoTime = z.string().datetime({ offset: true });
const eventsQuery = z.object({
  projectId: optional(z.string().uuid()),
  runId: optional(z.string().max(80)),
  sessionId: optional(z.string().max(80)),
  taskId: optional(z.string().max(80)),
  role: optional(z.enum(AGENT_ROLES)),
  level: optional(z.enum(['debug', 'info', 'warn', 'error'])),
  type: optional(z.string().max(60)),
  q: optional(z.string().max(200)),
  from: optional(isoTime),
  to: optional(isoTime),
  before: optional(z.coerce.number().int().positive()),
  limit: optional(z.coerce.number().int().min(1).max(500)).transform((limit) => limit ?? 100),
});
const usageDailyQuery = z.object({
  days: optional(z.coerce.number().int().min(1).max(MAX_USAGE_DAYS)).transform((days) => days ?? DEFAULT_USAGE_DAYS),
  projectId: optional(z.string().uuid()),
});

// ---- workspace sessions (AGENT_WORKSPACE_SPEC.md §8)
const idParam = z.object({ id: z.string().uuid() });
const effort = z.enum(['', ...EFFORT_LEVELS]);
const createSessionSchema = z.object({
  title: z.string().trim().max(120).optional(),
  role: z.enum(AGENT_ROLES),
  providerId: z.string().min(1).max(60),
  model: z.string().max(120),
  effort: effort.default(''),
  mode: z.enum(['readonly', 'edit']),
  taskId: z.string().uuid().nullable().optional(),
});
const patchSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  providerId: z.string().min(1).max(60).optional(),
  model: z.string().max(120).optional(),
  effort: effort.optional(),
  allowFallback: z.boolean().optional(),
  taskId: z.string().uuid().nullable().optional(),
}).strict();
const messageSchema = z.object({ text: z.string().trim().min(1).max(32_000) });
/** Destructive session actions need an explicit `{ "confirm": true }` body. */
const confirmSchema = z.object({ confirm: z.literal(true) });
const syncSchema = confirmSchema.extend({ onConflict: z.enum(['abort', 'resolve']).default('abort') });
const turnsQuery = z.object({
  before: optional(z.coerce.number().int().positive()),
  limit: optional(z.coerce.number().int().min(1).max(200)).transform((limit) => limit ?? 50),
});
const fileQuery = z.object({ path: z.string().min(1).max(500) });
const orchestratorSchema = z.object({ text: z.string().trim().min(1).max(8000), forwardTo: z.array(z.string().uuid()).max(16).default([]) });

// ---- workspace layout (§9): the shape is checked loosely; unknown extra fields are kept for the dashboard.
const LAYOUT_MAX_BYTES = 64 * 1024;
const shortId = z.string().min(1).max(100);
const layoutNode: z.ZodType<WorkspaceLayoutNode> = z.lazy(() => z.union([
  z.object({ type: z.literal('panel'), id: shortId }),
  z.object({ type: z.literal('split'), dir: z.enum(['row', 'col']), sizes: z.array(z.number().finite().nonnegative()).max(16),
    children: z.array(layoutNode).min(1).max(16) }),
]));
const layoutSchema = z.object({
  version: z.literal(1),
  preset: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(8), z.literal('custom')]),
  root: layoutNode,
  panels: z.record(shortId, z.object({ sessionId: z.string().max(100).nullable(), tab: z.enum(['chat', 'activity', 'changes', 'files', 'output', 'task', 'terminal']),
    kind: z.enum(['session', 'orchestrator']) }).passthrough()),
  maximized: shortId.nullable(),
  minimized: z.array(shortId).max(64),
  recentlyClosed: z.array(z.object({ sessionId: z.string().max(100), title: z.string().max(200), closedAt: z.string().max(40) }).passthrough()).max(50),
  drawer: z.object({ open: z.boolean(), tab: z.enum(['coordination', 'context', 'artifacts']), width: z.number().finite().min(0).max(10_000) }).passthrough(),
}).passthrough();

export interface V2RouteDeps {
  ctx: StudioContext;
  events?: EventStream;
}

/** V2 dashboard read models and workspace sessions. Registered inside registerRoutes, so its security hooks and error handler apply. */
export function registerV2Routes(app: FastifyInstance, { ctx, events = ctx.events }: V2RouteDeps): void {
  app.get('/api/v2/overview', async (request): Promise<OverviewResponse> =>
    buildOverview(ctx, overviewQuery.parse(request.query).projectId));
  app.get('/api/v2/usage/summary', async (request): Promise<UsageSummary> =>
    buildUsageSummary(ctx, usageQuery.parse(request.query).range));
  app.get('/api/v2/system/health', async (): Promise<SystemHealth & { budget: ProcessBudgetSnapshot }> =>
    ({ ...(await buildSystemHealth(ctx, events)), budget: ctx.budget.snapshot() }));
  app.get('/api/v2/usage/daily', async (request): Promise<UsageDailyResponse> => usageDaily(ctx, usageDailyQuery.parse(request.query)));
  app.get('/api/v2/events', async (request): Promise<EventsPage> => queryEvents(ctx, eventsQuery.parse(request.query)));
  app.get('/api/v2/budget', async (): Promise<ProcessBudgetSnapshot> => ctx.budget.snapshot());

  const { sessions } = ctx;
  const sessionId = (params: unknown): string => idParam.parse(params).id;
  const requireProject = (params: unknown): string => {
    const { id } = idParam.parse(params);
    if (!ctx.repos.projects.get(id)) throw new ProjectError('Project not found', 404);
    return id;
  };

  // ---- sessions of a project
  app.get('/api/v2/projects/:id/sessions', async (request) => sessions.list(requireProject(request.params)));
  app.post('/api/v2/projects/:id/sessions', async (request, reply) =>
    reply.code(201).send(await sessions.create(requireProject(request.params), createSessionSchema.parse(request.body))));

  // ---- one session
  app.get('/api/v2/sessions/:id', async (request) => sessions.get(sessionId(request.params)));
  app.patch('/api/v2/sessions/:id', async (request) => sessions.update(sessionId(request.params), patchSessionSchema.parse(request.body)));
  app.delete('/api/v2/sessions/:id', async (request) => {
    const id = sessionId(request.params);
    confirmSchema.parse(request.body);
    return sessions.close(id);
  });
  app.get('/api/v2/sessions/:id/turns', async (request) => sessions.turns(sessionId(request.params), turnsQuery.parse(request.query)));
  app.post('/api/v2/sessions/:id/messages', async (request, reply) =>
    reply.code(202).send(sessions.send(sessionId(request.params), messageSchema.parse(request.body).text)));
  app.post('/api/v2/sessions/:id/stop', async (request) => sessions.stop(sessionId(request.params)));
  app.post('/api/v2/sessions/:id/restart', async (request, reply) => reply.code(202).send(await sessions.restart(sessionId(request.params))));
  app.post('/api/v2/sessions/:id/checkpoint', async (request) => {
    const id = sessionId(request.params);
    confirmSchema.parse(request.body);
    return sessions.checkpoint(id);
  });
  app.post('/api/v2/sessions/:id/sync', async (request) => {
    const id = sessionId(request.params);
    return sessions.sync(id, syncSchema.parse(request.body).onConflict);
  });
  app.post('/api/v2/sessions/:id/merge', async (request) => {
    const id = sessionId(request.params);
    confirmSchema.parse(request.body);
    return sessions.merge(id);
  });
  app.post('/api/v2/sessions/:id/discard', async (request) => {
    const id = sessionId(request.params);
    confirmSchema.parse(request.body);
    return sessions.discard(id);
  });
  app.post('/api/v2/sessions/:id/run-tests', async (request) => sessions.runTests(sessionId(request.params)));
  app.get('/api/v2/sessions/:id/diff', async (request) => sessions.diff(sessionId(request.params)));
  app.get('/api/v2/sessions/:id/files', async (request) => sessions.files(sessionId(request.params)));
  app.get('/api/v2/sessions/:id/file', async (request) => sessions.file(sessionId(request.params), fileQuery.parse(request.query).path));

  // ---- workspace layout
  app.get('/api/v2/projects/:id/workspace-layout', async (request): Promise<{ layout: WorkspaceLayout | null }> =>
    ({ layout: ctx.repos.sessions.getLayout(requireProject(request.params)) }));
  app.put('/api/v2/projects/:id/workspace-layout', { bodyLimit: LAYOUT_MAX_BYTES }, async (request): Promise<{ layout: WorkspaceLayout }> => {
    const projectId = requireProject(request.params);
    const layout = layoutSchema.parse(request.body) as WorkspaceLayout;
    ctx.repos.sessions.saveLayout(projectId, layout);
    return { layout };
  });

  // ---- Studio Orchestrator inbox ("Message all agents")
  app.get('/api/v2/projects/:id/orchestrator/messages', async (request) => sessions.orchestratorMessages(requireProject(request.params)));
  app.post('/api/v2/projects/:id/orchestrator/messages', async (request, reply) => {
    const projectId = requireProject(request.params);
    const { text, forwardTo } = orchestratorSchema.parse(request.body);
    return reply.code(201).send(sessions.postOrchestratorMessage(projectId, text, forwardTo));
  });
}
