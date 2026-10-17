import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { WORKFLOW_LIMITS, WORKFLOW_NODE_TYPES, type RunsListPage, type RunsPage, type RunTimeline, type ValidationResult, type Workflow, type WorkflowGraph,
  type WorkflowSummary } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { NODE_CATALOG } from '../workflows/catalog.ts';
import { RunError, type RunService } from '../workflows/runService.ts';
import { validateWorkflow } from '../workflows/validate.ts';

// Workflow and run routes (WORKFLOW_ENGINE_SPEC.md §7). Registered after registerRoutes, so its security hooks and
// error handler apply; RunError with a ValidationResult is answered here with the result in `details`.

/** `?x=` (empty) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const projectParam = z.object({ id: z.string().uuid() });
/** Workflow ids are UUIDs or builtin ids (wf-standard); run ids are UUIDs or backfill ids (run-<projectId>). */
const idParam = z.object({ id: z.string().min(1).max(100) });
const confirmSchema = z.object({ confirm: z.literal(true) });
const listQuery = z.object({ projectId: optional(z.string().uuid()) });
const allRunsQuery = z.object({
  projectId: optional(z.string().uuid()),
  status: optional(z.enum(['planning', 'awaiting_approval', 'running', 'paused', 'completed', 'completed_with_failures', 'failed', 'cancelled'])),
  limit: optional(z.coerce.number().int().min(1).max(200)),
  before: optional(z.string().datetime()),
});
const runsQuery = z.object({
  limit: optional(z.coerce.number().int().min(1).max(50)),
  before: optional(z.coerce.number().int().positive()),
});

const name = z.string().trim().min(1).max(120);
const description = z.string().max(WORKFLOW_LIMITS.maxDescription);
const saveSchema = z.object({ name, description: description.optional(), projectId: z.string().uuid().nullable().optional(), graph: z.unknown() });
const duplicateSchema = z.object({ projectId: z.string().uuid().nullable().optional() });
const importSchema = z.object({ projectId: z.string().uuid().nullable().optional(), json: z.unknown() });
const validateSchema = z.object({ graph: z.unknown(), projectId: z.string().uuid().nullable().optional() });
const startSchema = z.object({ workflowId: z.string().min(1).max(100) });

/**
 * Structural shape of a graph (the validator's parse step, validate.ts). A graph that passes it is well formed and may be
 * saved as a draft even when validation finds errors; one that fails it is a 400 with the validator's E_LIMIT/E_CONFIG issues.
 */
const shapeSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    type: z.enum(WORKFLOW_NODE_TYPES),
    label: z.string().max(WORKFLOW_LIMITS.maxLabel).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    config: z.record(z.unknown()).default({}),
  })).max(WORKFLOW_LIMITS.maxNodes),
  edges: z.array(z.object({
    id: z.string().min(1).max(200),
    source: z.string().min(1),
    sourceHandle: z.enum(['out', 'pass', 'fail']).optional(),
    target: z.string().min(1),
    kind: z.enum(['normal', 'retry']).optional(),
  })).max(WORKFLOW_LIMITS.maxEdges),
});

function graphBytes(raw: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(raw) ?? '');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The well-formed graph, or a 400 RunError carrying the validator's shape issues. */
function wellFormedGraph(raw: unknown): WorkflowGraph {
  const parsed = graphBytes(raw) <= WORKFLOW_LIMITS.maxGraphBytes ? shapeSchema.safeParse(raw) : null;
  if (parsed?.success) return parsed.data as WorkflowGraph;
  const validation = validateWorkflow(raw);
  throw new RunError(`The workflow graph is malformed: ${validation.errors[0]?.message ?? 'unknown error'}`, 400, validation);
}

/** An exported workflow ({ name, description, graph }) or a bare graph. Ids of the source are never kept. */
function importedWorkflow(json: unknown): { name: string; description: string; graph: WorkflowGraph } {
  const value = (json && typeof json === 'object' && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const bare = 'nodes' in value && 'schemaVersion' in value;
  const fileName = name.safeParse(value.name);
  const fileDescription = description.safeParse(value.description ?? '');
  return {
    name: bare || !fileName.success ? 'Imported workflow' : fileName.data,
    description: bare || !fileDescription.success ? '' : fileDescription.data,
    graph: wellFormedGraph(bare ? value : value.graph),
  };
}

const copyName = (source: string): string => `Copy of ${source}`.slice(0, 120);
const fileNameOf = (workflowName: string): string =>
  `${workflowName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow'}.workflow.json`;

/** RunErrors with a ValidationResult keep it in `details`; everything else goes to the shared error handler. */
async function answer<T>(reply: FastifyReply, work: () => Promise<T> | T): Promise<T | FastifyReply> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RunError) return reply.code(error.statusCode).send({ error: error.message, ...(error.validation ? { details: error.validation } : {}) });
    throw error;
  }
}

export interface WorkflowRouteDeps {
  ctx: StudioContext;
  runs: RunService;
}

export function registerWorkflowRoutes(app: FastifyInstance, { ctx, runs }: WorkflowRouteDeps): void {
  const { workflows } = ctx.repos;
  const requireProject = (projectId: string | null | undefined): void => {
    if (projectId && !ctx.repos.projects.get(projectId)) throw new RunError('Project not found', 404);
  };
  const workflowId = (params: unknown): string => idParam.parse(params).id;

  // ---- workflows (static paths before '/:id' for readability; find-my-way prefers static segments anyway)
  app.get('/api/v2/workflows', async (request): Promise<{ workflows: WorkflowSummary[] }> =>
    ({ workflows: workflows.list({ projectId: listQuery.parse(request.query).projectId }) }));
  app.get('/api/v2/workflows/catalog', async () => ({ nodes: NODE_CATALOG }));
  app.post('/api/v2/workflows/validate', async (request): Promise<ValidationResult> => {
    const { graph, projectId } = validateSchema.parse(request.body);
    requireProject(projectId);
    return validateWorkflow(graph, await runs.validationContext(projectId ?? null));
  });
  app.post('/api/v2/workflows/import', async (request, reply) => answer(reply, () => {
    const { projectId, json } = importSchema.parse(request.body);
    requireProject(projectId);
    const workflow = workflows.create({ ...importedWorkflow(json), projectId: projectId ?? null });
    return reply.code(201).send({ workflow });
  }));
  app.post('/api/v2/workflows', async (request, reply) => answer(reply, () => {
    const body = saveSchema.parse(request.body);
    requireProject(body.projectId);
    const workflow = workflows.create({ name: body.name, description: body.description, projectId: body.projectId ?? null,
      graph: wellFormedGraph(body.graph) });
    return reply.code(201).send({ workflow });
  }));

  app.get('/api/v2/workflows/:id', async (request): Promise<{ workflow: Workflow }> => ({ workflow: runs.requireWorkflow(workflowId(request.params)) }));
  app.put('/api/v2/workflows/:id', async (request, reply) => answer(reply, () => {
    const id = workflowId(request.params);
    const body = saveSchema.parse(request.body);
    return { workflow: workflows.update(id, { name: body.name, description: body.description, graph: wellFormedGraph(body.graph) }) };
  }));
  app.delete('/api/v2/workflows/:id', async (request) => {
    const id = workflowId(request.params);
    confirmSchema.parse(request.body);
    return { workflow: workflows.archive(id) };
  });
  app.post('/api/v2/workflows/:id/duplicate', async (request, reply) => {
    const source = runs.requireWorkflow(workflowId(request.params));
    const { projectId } = duplicateSchema.parse(request.body ?? {});
    requireProject(projectId);
    const workflow = workflows.create({ name: copyName(source.name), description: source.description,
      projectId: projectId === undefined ? source.projectId : projectId, graph: source.graph });
    return reply.code(201).send({ workflow });
  });
  app.get('/api/v2/workflows/:id/export', async (request, reply) => {
    const { name: workflowName, description: text, graph } = runs.requireWorkflow(workflowId(request.params));
    return reply.header('Content-Disposition', `attachment; filename="${fileNameOf(workflowName)}"`)
      .send({ name: workflowName, description: text, graph });
  });
  app.post('/api/v2/workflows/:id/simulate', async (request) => {
    const workflow = runs.requireWorkflow(workflowId(request.params));
    return runs.simulate(workflow.id, await runs.validationContext(workflow.projectId));
  });

  // ---- runs
  app.post('/api/v2/projects/:id/runs', async (request, reply) => answer(reply, async () => {
    const { id } = projectParam.parse(request.params);
    const run = await runs.startChecked(id, startSchema.parse(request.body).workflowId);
    return reply.code(201).send({ run });
  }));
  app.get('/api/v2/projects/:id/runs', async (request): Promise<RunsPage> =>
    runs.list(projectParam.parse(request.params).id, runsQuery.parse(request.query)));
  app.get('/api/v2/runs', async (request): Promise<RunsListPage> => ctx.repos.runs.listAll(allRunsQuery.parse(request.query)));
  app.get('/api/v2/runs/:id', async (request) => ({ run: runs.get(idParam.parse(request.params).id) }));
  app.get('/api/v2/runs/:id/timeline', async (request): Promise<RunTimeline> => runs.timeline(idParam.parse(request.params).id));
  app.post('/api/v2/runs/:id/cancel', async (request) => {
    const { id } = idParam.parse(request.params);
    confirmSchema.parse(request.body);
    return { run: runs.cancel(id) };
  });
}
