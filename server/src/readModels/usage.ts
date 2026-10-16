import type { UsageDailyResponse, UsageDailyRow, UsageModelRow, UsageSummary } from '@asf/shared';
import { localDate } from '../db/repositories.ts';
import type { StudioContext } from '../orchestrator/context.ts';
import { readDb } from './logs.ts';

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_USAGE_DAYS = 30;
export const MAX_USAGE_DAYS = 90;

/**
 * Token usage for the Home page. '24h' = the last 24 hours; '7d' = today plus the six previous local days
 * (from local midnight), so byDay always has 7 entries. The previous window has the same length and ends at `from`.
 */
export function buildUsageSummary(ctx: StudioContext, range: '24h' | '7d', now = new Date()): UsageSummary {
  const fromDate = range === '24h'
    ? new Date(now.getTime() - 24 * HOUR_MS)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const from = fromDate.toISOString();
  const to = now.toISOString();
  const previousFrom = new Date(fromDate.getTime() - (now.getTime() - fromDate.getTime())).toISOString();

  const rows = ctx.repos.usage.window(from, to);
  const byModel: UsageModelRow[] = rows
    .map((r) => ({
      providerId: r.providerId, providerLabel: ctx.registry.get(r.providerId)?.label ?? null, model: r.model,
      calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costRows ? r.costUsd : null,
    }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  const costRows = rows.reduce((n, r) => n + r.costRows, 0);

  const tokensByDay = new Map(ctx.repos.usage.byDay(from, to).map((d) => [d.date, d.totalTokens]));
  const byDay: UsageSummary['byDay'] = [];
  const lastDay = localDate(now);
  for (let day = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate()); ; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const date = localDate(day);
    byDay.push({ date, totalTokens: tokensByDay.get(date) ?? 0 });
    if (date >= lastDay) break;
  }

  return {
    range, from, to,
    totalTokens: rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
    previousTotalTokens: ctx.repos.usage.tokensBetween(previousFrom, from),
    calls: rows.reduce((n, r) => n + r.calls, 0),
    costUsd: costRows ? rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) : null,
    byModel,
    byDay,
  };
}

// ------------------------------------------------------------------ daily analytics (Models page, Usage tab)

const optionalString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/**
 * Usage per server-local day × provider × model × project for the last `days` local days (today included).
 * costUsd is null when no record of the group reported a cost (a reported 0 stays 0); projectName is null for deleted projects.
 */
export function usageDaily(ctx: StudioContext, opts: { days?: number; projectId?: string } = {}, now = new Date()): UsageDailyResponse {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? DEFAULT_USAGE_DAYS) || DEFAULT_USAGE_DAYS, 1), MAX_USAGE_DAYS);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).toISOString();
  const params: string[] = [from];
  let projectFilter = '';
  if (opts.projectId) { projectFilter = 'AND u.project_id = ?'; params.push(opts.projectId); }
  const rows = readDb(ctx).prepare(`SELECT date(u.created_at, 'localtime') AS day, u.provider_id, u.model, u.project_id,
      p.name AS project_name, COALESCE(SUM(u.input_tokens), 0) AS i, COALESCE(SUM(u.output_tokens), 0) AS o,
      SUM(u.cost_usd) AS c, COUNT(*) AS n
    FROM usage_records u LEFT JOIN projects p ON p.id = u.project_id
    WHERE u.created_at >= ? ${projectFilter}
    GROUP BY day, u.provider_id, u.model, u.project_id
    ORDER BY day, u.provider_id, u.model, u.project_id`).all(...params) as Record<string, unknown>[];
  const result: UsageDailyRow[] = rows.map((r) => ({
    day: String(r.day), providerId: String(r.provider_id), model: optionalString(r.model), projectId: optionalString(r.project_id),
    projectName: optionalString(r.project_name), inputTokens: Number(r.i), outputTokens: Number(r.o),
    costUsd: r.c === null ? null : Number(r.c), calls: Number(r.n),
  }));
  return { days, rows: result };
}
