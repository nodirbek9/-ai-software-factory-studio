import type { UsageModelRow, UsageSummary } from '@asf/shared';
import { localDate } from '../db/repositories.ts';
import type { StudioContext } from '../orchestrator/context.ts';

const HOUR_MS = 60 * 60 * 1000;

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
