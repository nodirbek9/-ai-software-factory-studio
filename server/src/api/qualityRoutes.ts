import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FINDING_SEVERITIES, type FindingSource, type FindingsResponse, type FindingStatus, type QualityOverview } from '@asf/shared';
import type { QualityService } from '../quality/qualityService.ts';

// Phase 6 QA & Security routes (PHASE_6.md, UI_SCREEN_SPECIFICATIONS.md §8). Registered after registerRoutes, so its
// security hooks and error handler apply (ProjectError → its status, ZodError → 400).

/** `?x=` (empty) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const FINDING_SOURCES = ['security', 'review', 'audit'] as const satisfies readonly FindingSource[];
const FINDING_STATUSES = ['open', 'accepted', 'false_positive', 'fix_planned', 'fixed'] as const satisfies readonly FindingStatus[];

const findingQuery = z.object({
  projectId: optional(z.string().uuid()),
  /** A run UUID or a backfill id run-<projectId>. */
  runId: optional(z.string().min(1).max(100)),
  severity: optional(z.enum(FINDING_SEVERITIES)),
  source: optional(z.enum(FINDING_SOURCES)),
  status: optional(z.enum(FINDING_STATUSES)),
  q: optional(z.string().max(200)),
  limit: optional(z.coerce.number().int().min(1).max(2000)),
});
const updateSchema = z.object({
  status: z.enum(['open', 'accepted', 'false_positive']),
  note: z.string().trim().max(2000).nullable().optional(),
});
const qualityQuery = z.object({ runId: optional(z.string().min(1).max(100)) });
const idParam = z.object({ id: z.string().min(1).max(100) });
const projectParam = z.object({ id: z.string().uuid() });
const confirmSchema = z.object({ confirm: z.literal(true) });

export interface QualityRouteDeps {
  quality: QualityService;
}

export function registerQualityRoutes(app: FastifyInstance, { quality }: QualityRouteDeps): void {
  app.get('/api/v2/findings', async (request): Promise<FindingsResponse> => quality.listFindings(findingQuery.parse(request.query)));
  app.patch('/api/v2/findings/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { status, note } = updateSchema.parse(request.body);
    return { finding: quality.updateFinding(id, { status, ...(note !== undefined ? { note: note || null } : {}) }) };
  });
  app.post('/api/v2/findings/:id/fix-task', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    confirmSchema.parse(request.body);
    return reply.code(201).send({ task: quality.createFixTask(id) });
  });
  app.get('/api/v2/projects/:id/quality', async (request): Promise<QualityOverview> =>
    quality.overview(projectParam.parse(request.params).id, qualityQuery.parse(request.query).runId));
  app.post('/api/v2/projects/:id/quality/audit', async (request, reply) => {
    const { id } = projectParam.parse(request.params);
    confirmSchema.parse(request.body);
    return reply.code(201).send({ approval: quality.requestAudit(id) });
  });
}
