import type { UsageModelRow, UsageSummary } from '@asf/shared';
import { formatTokens } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { EmptyState, ErrorState, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import type { V2Result } from './useV2';
import { weekdayLabel } from './format';

const SLICE_COLORS = ['var(--color-brand)', 'var(--color-brand-2)', 'var(--color-brand-violet)', 'var(--color-agent-claude)', 'var(--color-st-completed)', 'var(--color-st-idle)'];
const MAX_SLICES = 5;

interface Slice { key: string; label: string; tokens: number; color: string }

function rowLabel(row: UsageModelRow): string {
  const provider = row.providerLabel ?? row.providerId;
  return row.model ? `${provider} · ${row.model}` : provider;
}

/** Top models by tokens; everything after the fifth is summed into "Other" so the donut stays readable. */
function toSlices(rows: UsageModelRow[]): Slice[] {
  const sorted = rows.map((row) => ({ row, tokens: row.inputTokens + row.outputTokens })).filter((entry) => entry.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const slices: Slice[] = sorted.slice(0, MAX_SLICES).map(({ row, tokens }, index) => ({
    key: `${row.providerId}:${row.model ?? ''}`, label: rowLabel(row), tokens, color: SLICE_COLORS[index],
  }));
  const rest = sorted.slice(MAX_SLICES).reduce((sum, entry) => sum + entry.tokens, 0);
  if (rest > 0) slices.push({ key: 'other', label: 'Other', tokens: rest, color: SLICE_COLORS[MAX_SLICES] });
  return slices;
}

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Donut({ slices, total }: { slices: Slice[]; total: number }) {
  const sum = slices.reduce((s, slice) => s + slice.tokens, 0);
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" className="h-[120px] w-[120px] shrink-0" role="img" aria-label={`Tokens by model, ${formatTokens(total)} in total`}>
      <circle cx="50" cy="50" r={RADIUS} fill="none" stroke="var(--color-ink-700)" strokeWidth="12" />
      {sum > 0 && slices.map((slice) => {
        const length = (slice.tokens / sum) * CIRCUMFERENCE;
        const circle = (
          <circle key={slice.key} cx="50" cy="50" r={RADIUS} fill="none" stroke={slice.color} strokeWidth="12"
            strokeDasharray={`${length} ${CIRCUMFERENCE - length}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)" />
        );
        offset += length;
        return circle;
      })}
      <text x="50" y="49" textAnchor="middle" className="fill-text text-[15px] font-semibold">{formatTokens(total)}</text>
      <text x="50" y="62" textAnchor="middle" className="fill-muted text-[7px]">tokens</text>
    </svg>
  );
}

function DayBars({ days }: { days: UsageSummary['byDay'] }) {
  const max = Math.max(0, ...days.map((day) => day.totalTokens));
  return (
    <div className="flex h-[72px] items-end gap-1.5" role="img" aria-label="Tokens per day, last 7 days">
      {days.map((day) => (
        <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${day.date}: ${formatTokens(day.totalTokens)} tokens`}>
          <div className="w-full rounded-sm bg-brand/70" style={{ height: `${max ? Math.max(3, (day.totalTokens / max) * 100) : 3}%`, maxHeight: 'calc(100% - 14px)' }} />
          <span className="text-[10px] leading-none text-faint">{weekdayLabel(day.date)}</span>
        </div>
      ))}
    </div>
  );
}

export function ModelUsage({ usage24, usage7 }: { usage24: V2Result<UsageSummary>; usage7: V2Result<UsageSummary> }) {
  const setView = useStudio((s) => s.setView);
  const day = usage24.data;
  const slices = day ? toSlices(day.byModel) : [];
  const sliceTotal = slices.reduce((sum, slice) => sum + slice.tokens, 0);
  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Model Usage (24 h)">
        <button type="button" onClick={() => setView('models')} className="rounded text-[12px] text-brand hover:underline">View models →</button>
      </PanelHeader>
      <div className="space-y-4 p-4">
        {day ? (
          <>
            {slices.length ? (
              <div className="flex items-center gap-4">
                <Donut slices={slices} total={day.totalTokens} />
                <ul className="min-w-0 flex-1 space-y-1.5" aria-label="Tokens by model">
                  {slices.map((slice) => (
                    <li key={slice.key} className="flex items-center gap-2 text-[12px]">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: slice.color }} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate" title={slice.label}>{slice.label}</span>
                      <span className="shrink-0 tabular-nums text-muted">{formatTokens(slice.tokens)}</span>
                      <span className="w-10 shrink-0 text-right tabular-nums text-faint">{Math.round((slice.tokens / sliceTotal) * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="py-4 text-center text-[13px] text-muted">
                {day?.calls ? 'No tokens reported in the last 24 h (offline or non-AI providers report none).' : 'No model calls in the last 24 h.'}
              </p>
            )}
            <p className="text-[11.5px] text-muted">
              {day.calls} model call{day.calls === 1 ? '' : 's'}
              {day.costUsd !== null && <> · reported cost ${day.costUsd.toFixed(2)}</>}
            </p>
          </>
        ) : usage24.error ? (
          <ErrorState title="Usage unavailable" message={usage24.error} onRetry={usage24.reload} />
        ) : (
          <Skeleton className="h-[120px] w-full" />
        )}

        <div className="border-t border-line-soft pt-3">
          <p className="mb-2 text-[11.5px] font-medium text-muted">Last 7 days</p>
          {usage7.data ? (
            usage7.data.byDay.length ? <DayBars days={usage7.data.byDay} /> : <EmptyState title="No daily data" />
          ) : usage7.error ? (
            <ErrorState title="Daily usage unavailable" message={usage7.error} onRetry={usage7.reload} />
          ) : (
            <Skeleton className="h-[72px] w-full" />
          )}
        </div>
      </div>
    </Panel>
  );
}
