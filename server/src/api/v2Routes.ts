import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventsPage, OverviewResponse, SystemHealth, UsageSummary } from '@asf/shared';
import type { EventStream } from '../events/eventStream.ts';
import type { StudioContext } from '../orchestrator/context.ts';
import { buildSystemHealth } from '../readModels/health.ts';
import { buildOverview } from '../readModels/overview.ts';
import { buildUsageSummary } from '../readModels/usage.ts';

/** `?x=` (empty) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const overviewQuery = z.object({ projectId: optional(z.string().uuid()) });
const usageQuery = z.object({ range: optional(z.enum(['24h', '7d'])).transform((range) => range ?? '24h') });
const eventsQuery = z.object({
  projectId: optional(z.string().uuid()),
  before: optional(z.coerce.number().int().positive()),
  limit: optional(z.coerce.number().int().min(1).max(500)).transform((limit) => limit ?? 100),
  level: optional(z.enum(['debug', 'info', 'warn', 'error'])),
  type: optional(z.string().max(60)),
});

export interface V2RouteDeps {
  ctx: StudioContext;
  events?: EventStream;
}

/** Read models for the V2 dashboard. Registered inside registerRoutes, so its security hooks and error handler apply. */
export function registerV2Routes(app: FastifyInstance, { ctx, events = ctx.events }: V2RouteDeps): void {
  app.get('/api/v2/overview', async (request): Promise<OverviewResponse> =>
    buildOverview(ctx, overviewQuery.parse(request.query).projectId));
  app.get('/api/v2/usage/summary', async (request): Promise<UsageSummary> =>
    buildUsageSummary(ctx, usageQuery.parse(request.query).range));
  app.get('/api/v2/system/health', async (): Promise<SystemHealth> => buildSystemHealth(ctx, events));
  app.get('/api/v2/events', async (request): Promise<EventsPage> => ctx.repos.events.page(eventsQuery.parse(request.query)));
}
