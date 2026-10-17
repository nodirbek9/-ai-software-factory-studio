import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UsageDailyRow } from '@asf/shared';
import { EmptyState, ErrorState, Panel, PanelHeader, Select, Skeleton } from '@/components/ui/primitives';
import { cn, formatTokens } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { getUsageDaily } from './usageApi';

export const USAGE_RANGES = [7, 30, 90] as const;
export const USAGE_GROUPS = [
  { id: 'day', label: 'Day' },
  { id: 'provider', label: 'Provider' },
  { id: 'model', label: 'Model' },
  { id: 'project', label: 'Project' },
] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number]['id'];

export interface UsageGroupRow {
  key: string;
  label: string;
  /** Second line under the label (the provider of a model). */
  detail: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Sum of the reported costs; null when no record of the group reported one (never 0 for unknown). */
  costUsd: number | null;
  calls: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  calls: number;
  /** Some groups reported a cost and some did not, so the total is a lower bound. */
  partialCost: boolean;
}

export const formatUsageCost = (costUsd: number | null): string =>
  costUsd === null ? '—' : `$${costUsd.toFixed(costUsd > 0 && costUsd < 0.01 ? 4 : 2)}`;

const sumCost = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

function identity(row: UsageDailyRow, group: UsageGroup, providerLabel: (id: string) => string): Pick<UsageGroupRow, 'key' | 'label' | 'detail'> {
  switch (group) {
    case 'day': return { key: row.day, label: row.day, detail: null };
    case 'provider': return { key: row.providerId, label: providerLabel(row.providerId), detail: null };
    case 'model': return { key: `${row.providerId}\u0000${row.model ?? ''}`, label: row.model || 'Default', detail: providerLabel(row.providerId) };
    case 'project': return { key: row.projectId ?? '', label: row.projectName ?? 'No project', detail: null };
  }
}

/** Folds the server's day × provider × model × project rows into one row per group value. */
export function groupUsage(rows: UsageDailyRow[], group: UsageGroup, providerLabel: (id: string) => string = (id) => id): UsageGroupRow[] {
  const groups = new Map<string, UsageGroupRow>();
  for (const row of rows) {
    const id = identity(row, group, providerLabel);
    const current = groups.get(id.key) ?? { ...id, inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0 };
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.costUsd = sumCost(current.costUsd, row.costUsd);
    current.calls += row.calls;
    groups.set(id.key, current);
  }
  const grouped = [...groups.values()];
  return group === 'day'
    ? grouped.sort((a, b) => b.key.localeCompare(a.key))
    : grouped.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.label.localeCompare(b.label));
}

export function totalUsage(rows: UsageGroupRow[]): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0, partialCost: false };
  for (const row of rows) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd = sumCost(totals.costUsd, row.costUsd);
    totals.calls += row.calls;
  }
  totals.partialCost = totals.costUsd !== null && rows.some((row) => row.costUsd === null);
  return totals;
}

function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={value === option.id} onClick={() => onChange(option.id)}
            className={cn('rounded-md border px-2.5 py-1 text-[12px] transition-colors',
              value === option.id ? 'border-brand bg-brand/15 text-text' : 'border-line text-muted hover:border-faint hover:text-text')}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rows: UsageDailyRow[] };

function UsageTable({ rows, group }: { rows: UsageGroupRow[]; group: UsageGroup }) {
  const totals = totalUsage(rows);
  const groupLabel = USAGE_GROUPS.find((item) => item.id === group)?.label ?? 'Group';
  const maxTokens = Math.max(1, ...rows.map((row) => row.inputTokens + row.outputTokens));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <caption className="sr-only">Provider usage by {groupLabel.toLowerCase()}</caption>
        <thead className="border-b border-line-soft text-muted">
          <tr>
            {[groupLabel, 'Tokens', 'Input tokens', 'Output tokens', 'Cost (USD)', 'Calls'].map((label, index) => (
              <th key={label} scope="col" className={cn('whitespace-nowrap px-4 py-2 font-medium', index > 1 && 'text-right')}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line-soft">
              <td className="break-all px-4 py-2">
                {row.label}
                {row.detail && <span className="block text-[11px] text-faint">{row.detail}</span>}
              </td>
              <td className="w-40 px-4 py-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-ink-800" aria-hidden="true">
                  <div className="h-full rounded-full bg-brand" data-testid="usage-bar" style={{ width: `${((row.inputTokens + row.outputTokens) / maxTokens) * 100}%` }} />
                </div>
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatUsageCost(row.costUsd)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{row.calls.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium" data-testid="usage-totals">
            <th scope="row" className="px-4 py-2 text-left">Total</th>
            <td className="px-4 py-2" />
            <td className="px-4 py-2 text-right tabular-nums">{formatTokens(totals.inputTokens)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatTokens(totals.outputTokens)}</td>
            <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums"
              title={totals.partialCost ? 'Some calls did not report a cost, so this is a lower bound.' : undefined}>
              {formatUsageCost(totals.costUsd)}{totals.partialCost ? '+' : ''}
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{totals.calls.toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Models → Usage: tokens, cost and calls from `usage_records`, by day, provider, model or project. */
export function UsageTab() {
  const providers = useStudio((state) => state.providers);
  const projects = useStudio((state) => state.projects);
  const currentProjectId = useStudio((state) => state.currentProjectId);
  const [days, setDays] = useState<number>(30);
  const [group, setGroup] = useState<UsageGroup>('day');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const projectId = scope === 'current' && currentProjectId ? currentProjectId : undefined;
  const currentName = projects.find((project) => project.id === currentProjectId)?.name;

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    getUsageDaily(days, projectId).then((response) => {
      if (active) setState({ status: 'ready', rows: response.rows });
    }).catch((error: unknown) => {
      if (active) setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load usage.' });
    });
    return () => { active = false; };
  }, [days, projectId, attempt]);

  const providerLabel = useCallback((id: string) => providers.find((provider) => provider.id === id)?.label ?? id, [providers]);
  const grouped = useMemo(() => (state.status === 'ready' ? groupUsage(state.rows, group, providerLabel) : []), [state, group, providerLabel]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <h1 className="text-lg font-semibold">Usage</h1>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Segmented label="Range" value={days} onChange={setDays}
          options={USAGE_RANGES.map((range) => ({ id: range, label: `${range} days` }))} />
        <Segmented label="Group by" value={group} onChange={setGroup} options={USAGE_GROUPS} />
        <label className="flex items-center gap-2 text-[12px] font-medium text-muted">
          Project
          <Select aria-label="Project" className="w-auto max-w-[240px]" value={scope} onChange={(event) => setScope(event.target.value as 'all' | 'current')}>
            <option value="all">All projects</option>
            <option value="current" disabled={!currentProjectId}>
              {currentProjectId ? (currentName ?? 'Current project') : 'Current project (none selected)'}
            </option>
          </Select>
        </label>
      </div>
      <Panel>
        <PanelHeader title={`Last ${days} days`} />
        {state.status === 'loading' ? (
          <div role="status" aria-label="Loading usage" className="space-y-2 p-4">
            <Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-2/3" />
          </div>
        ) : state.status === 'error' ? (
          <ErrorState title="Usage could not be loaded" message={state.message} onRetry={() => setAttempt((count) => count + 1)} />
        ) : !grouped.length ? (
          <EmptyState title="No usage recorded">Run a project with a provider to see its tokens, cost and calls here.</EmptyState>
        ) : <UsageTable rows={grouped} group={group} />}
      </Panel>
      <p className="text-[12px] text-faint">Costs only when the provider reports them (D-011). “—” means no cost was reported, not zero.</p>
    </div>
  );
}
