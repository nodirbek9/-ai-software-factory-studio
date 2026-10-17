import type { ProviderInfo } from '@asf/shared';
import { Button, EmptyState, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { limitLabel } from '@/pages/Providers';
import { useStudio } from '@/store/studio';

interface Availability {
  label: string;
  tone: 'ok' | 'warn' | 'bad';
}

/** Whether the provider can take a fallback attempt right now, and why not. */
export function providerAvailability(provider: ProviderInfo | undefined): Availability {
  if (!provider) return { label: 'Not registered on this server', tone: 'bad' };
  if (!provider.enabled) return { label: 'Disabled', tone: 'warn' };
  if (!provider.available) return { label: provider.reason ? `Unavailable: ${provider.reason}` : 'Unavailable', tone: 'bad' };
  const limit = limitLabel(provider);
  if (limit) return { label: limit, tone: 'warn' };
  return { label: 'Available', tone: 'ok' };
}

const TONE = { ok: 'text-st-completed', warn: 'text-st-waiting', bad: 'text-st-failed' } as const;

/** Models → Fallback order: read-only view of the order edited in Settings (P6-6). */
export function FallbackTab() {
  const info = useStudio((state) => state.info);
  const providers = useStudio((state) => state.providers);
  const setView = useStudio((state) => state.setView);
  const order = info ? [...new Set(info.settings.fallbackOrder ?? [])] : [];
  const excluded = providers.filter((provider) => !order.includes(provider.id));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Fallback order</h1>
        <Button onClick={() => setView('settings')}>Edit in Settings</Button>
      </div>
      <p className="text-muted">When an agent allows fallback and its provider fails or is limited, these providers are tried in this order.</p>
      <Panel>
        <PanelHeader title="Providers tried in order" />
        {!info ? (
          <div role="status" aria-label="Loading fallback order" className="space-y-2 p-4"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-2/3" /></div>
        ) : !order.length ? (
          <EmptyState title="No fallback providers">Fallback is off for every agent. Add providers in Settings to enable it.</EmptyState>
        ) : (
          <ol aria-label="Fallback order" className="divide-y divide-line-soft">
            {order.map((id, index) => {
              const provider = providers.find((item) => item.id === id);
              const availability = providerAvailability(provider);
              return (
                <li key={id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-5 text-right tabular-nums text-faint" aria-hidden="true">{index + 1}</span>
                  <span className="min-w-0 flex-1 break-words font-medium">{provider?.label ?? id}</span>
                  <span className={cn('text-[12px]', TONE[availability.tone])}>{availability.label}</span>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      {info && excluded.length > 0 && (
        <p className="text-[12px] text-faint">Not used for fallback: {excluded.map((provider) => provider.label).join(', ')}.</p>
      )}
    </div>
  );
}
