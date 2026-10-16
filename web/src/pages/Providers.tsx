import { useEffect, useState } from 'react';
import type { ProviderInfo } from '@asf/shared';
import { RefreshCw } from 'lucide-react';
import { Button, EmptyState, Field, Input, Panel, PanelHeader, Progress } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatTokens } from '@/lib/utils';
import { useStudio } from '@/store/studio';

interface UsageRow {
  providerId: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
/** Subscription CLIs sign in with a login; API providers read a key from the server .env (never shown). */
const KIND_LABEL = { cli: 'CLI login', api: 'API key', builtin: 'Built-in' } as const;

/** Providers with native session resume (Phase 3 continuity: claude-code and its claude-code-<n> logins, codex); the rest replay context. */
const NATIVE_RESUME = /^(claude-code(-\d+)?|codex)$/;
export const resumeLabel = (providerId: string): string => (NATIVE_RESUME.test(providerId) ? 'Native resume' : 'Context replay');

/** "Limit until hh:mm" (local time) while the provider's usage limit is used up, else null. */
export function limitLabel(provider: Pick<ProviderInfo, 'limitedUntil'>): string | null {
  if (!provider.limitedUntil) return null;
  const until = new Date(provider.limitedUntil);
  if (Number.isNaN(until.getTime())) return null;
  return `Limit until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

function ProviderCard({ provider }: { provider: ProviderInfo }) {
  const [budget, setBudget] = useState(provider.budgetUsd?.toString() ?? '');
  const [baseUrl, setBaseUrl] = useState(provider.settings.baseUrl ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(provider.settings.apiKeyEnv ?? '');
  const [models, setModels] = useState(provider.settings.models ?? '');
  const [configDir, setConfigDir] = useState(provider.settings.configDir ?? '');
  /** Extra Claude Code logins are registered as claude-code-<n>. */
  const accountNumber = /^claude-code-(\d+)$/.exec(provider.id)?.[1] ?? null;
  const [pending, setPending] = useState(false);
  useEffect(() => setConfigDir(provider.settings.configDir ?? ''), [provider.settings.configDir]);
  useEffect(() => setBudget(provider.budgetUsd?.toString() ?? ''), [provider.budgetUsd]);
  useEffect(() => setBaseUrl(provider.settings.baseUrl ?? ''), [provider.settings.baseUrl]);
  useEffect(() => setApiKeyEnv(provider.settings.apiKeyEnv ?? ''), [provider.settings.apiKeyEnv]);
  useEffect(() => setModels(provider.settings.models ?? ''), [provider.settings.models]);

  const update = async (body: { enabled?: boolean; budgetUsd?: number | null; settings?: Record<string, string> }) => {
    setPending(true);
    try {
      await useStudio.getState().updateProvider(provider.id, body);
    } catch (error) {
      useStudio.getState().setError(error instanceof Error ? error.message : 'Could not update provider.');
    } finally {
      setPending(false);
    }
  };
  const saveBudget = () => {
    const value = budget.trim() === '' ? null : Number(budget);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      useStudio.getState().setError('Enter a non-negative budget in USD, or leave it empty for no limit.');
      return;
    }
    void update({ budgetUsd: value });
  };
  const hasBudget = provider.budgetUsd !== null;
  const budgetRatio = provider.budgetUsd !== null && provider.budgetUsd > 0
    ? provider.spentUsd / provider.budgetUsd : hasBudget ? 1 : 0;

  return (
    <Panel className="min-w-0">
      <PanelHeader title={provider.label}>
        <span className="text-[11px] text-muted">{KIND_LABEL[provider.kind]}</span>
        {!provider.isAi && <span className="rounded-full border border-st-waiting/30 bg-st-waiting/10 px-2 py-0.5 text-[11px] text-st-waiting">Not AI</span>}
      </PanelHeader>
      <div className="space-y-3 p-4">
        <p className={`break-words text-[12px] ${provider.available ? 'text-st-completed' : 'text-st-waiting'}`}>
          {provider.available ? `Detected${provider.version ? ` ${provider.version}` : ''}` : provider.reason || 'Unavailable. Re-detect after configuring this provider.'}
        </p>
        {limitLabel(provider) && <p className="text-[12px] text-st-waiting">{limitLabel(provider)}</p>}
        <p className="text-[12px] text-muted">{provider.editsFiles ? 'Edits files directly' : 'Uses file-edit protocol'} · {resumeLabel(provider.id)}</p>
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" role="switch" className="accent-brand" checked={provider.enabled} disabled={pending}
            onChange={(event) => void update({ enabled: event.target.checked })} />
          Enabled
        </label>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); saveBudget(); }}>
          <Field label="Budget (USD)" hint="Leave empty for no limit.">
            <Input type="number" min="0" step="any" placeholder="No limit" value={budget} disabled={pending}
              onChange={(event) => setBudget(event.target.value)} />
          </Field>
          <Button type="submit" size="sm" disabled={pending}>Save</Button>
        </form>
        <div className="space-y-2">
          <p className="text-[12px] text-muted">Spent <span className="tabular-nums text-text">{usd(provider.spentUsd)}</span>
            {hasBudget ? ` of ${usd(provider.budgetUsd!)}` : ' · No budget limit'}</p>
          {hasBudget && <div aria-label={`${provider.label} budget usage`}>
            <Progress value={budgetRatio} color={budgetRatio >= 1 ? 'var(--color-st-waiting)' : undefined} />
          </div>}
        </div>
        <div>
          <h3 className="mb-1 text-[12px] font-medium text-muted">Models</h3>
          {provider.models.length ? <ul className="flex flex-wrap gap-1.5">
            {provider.models.map((model) => <li key={model} className="max-w-full break-all rounded border border-line bg-ink-950 px-2 py-0.5 text-[11px]">{model}</li>)}
          </ul> : <p className="text-[12px] text-faint">No models reported. Configure the provider and re-detect.</p>}
        </div>
        {accountNumber && (
          <form className="space-y-3 border-t border-line-soft pt-3" onSubmit={(event) => {
            event.preventDefault();
            void update({ settings: { ...provider.settings, configDir: configDir.trim() } });
          }}>
            <Field label={`Claude config folder of login ${accountNumber}`}
              hint={`Empty = %USERPROFILE%\\.claude-account${accountNumber} (the login your claude${accountNumber} command uses).`}>
              <Input placeholder={`C:\\Users\\you\\.claude-account${accountNumber}`} spellCheck={false} value={configDir} disabled={pending}
                onChange={(event) => setConfigDir(event.target.value)} />
            </Field>
            <Button type="submit" size="sm" disabled={pending}>Save settings</Button>
          </form>
        )}
        {provider.id === 'openai-compatible' && (
          <form className="space-y-3 border-t border-line-soft pt-3" onSubmit={(event) => {
            event.preventDefault();
            void update({ settings: { ...provider.settings, baseUrl: baseUrl.trim(), apiKeyEnv: apiKeyEnv.trim(),
              models: models.split(',').map((model) => model.trim()).filter(Boolean).join(',') } });
          }}>
            <fieldset disabled={pending} className="space-y-3">
              <Field label="Base URL" hint="The OpenAI-compatible API base URL, including /v1 when required.">
                <Input type="url" placeholder="https://api.example.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </Field>
              <Field label="API key environment variable" hint="Enter the name of the variable in the studio server .env holding the key, never the key itself.">
                <Input placeholder="ASF_OPENAI_API_KEY" autoComplete="off" spellCheck={false} pattern="[A-Za-z_][A-Za-z0-9_]*"
                  value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} />
              </Field>
              <Field label="Models (comma-separated)">
                <Input value={models} onChange={(event) => setModels(event.target.value)} placeholder="model-a, model-b" />
              </Field>
            </fieldset>
            <Button type="submit" size="sm" disabled={pending}>Save settings</Button>
          </form>
        )}
      </div>
    </Panel>
  );
}

export function Providers() {
  const { providers, refreshProviders } = useStudio();
  const [detecting, setDetecting] = useState(false);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [usageState, setUsageState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    void api<UsageRow[]>('/api/usage').then((rows) => {
      if (active) { setUsage(rows); setUsageState('ready'); }
    }).catch((error: unknown) => {
      if (active) {
        setUsageState('error');
        useStudio.getState().setError(error instanceof Error ? error.message : 'Could not load usage.');
      }
    });
    return () => { active = false; };
  }, []);

  const detect = async () => {
    setDetecting(true);
    try {
      await refreshProviders(true);
    } catch (error) {
      useStudio.getState().setError(error instanceof Error ? error.message : 'Could not detect providers.');
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Providers</h1>
        <Button onClick={() => void detect()} disabled={detecting}><RefreshCw size={14} className={detecting ? 'animate-spin' : ''} />{detecting ? 'Detecting…' : 'Re-detect'}</Button>
      </div>
      <p className="text-muted">API keys are read only from the server .env and are never shown in the browser. Configure credentials on the server, then re-detect providers.</p>
      {providers.length ? <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
      </div> : <Panel><EmptyState title="No providers loaded">Use Re-detect to check the server for available providers.</EmptyState></Panel>}
      <Panel>
        <PanelHeader title="Usage" />
        {usageState === 'loading' ? <p role="status" className="p-4 text-muted">Loading usage…</p>
          : usageState === 'error' ? <EmptyState title="Usage could not be loaded">Reopen this page to try again.</EmptyState>
          : !usage.length ? <EmptyState title="No usage recorded">Run a project with a provider to see its calls, tokens and cost here.</EmptyState>
          : <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">Recorded provider usage and costs in USD</caption>
              <thead className="border-b border-line-soft text-muted">
                <tr>{['Provider', 'Model', 'Calls', 'Input tokens', 'Output tokens', 'Cost (USD)'].map((label, index) =>
                  <th key={label} scope="col" className={`whitespace-nowrap px-4 py-2 font-medium ${index > 1 ? 'text-right' : ''}`}>{label}</th>)}</tr>
              </thead>
              <tbody>{usage.map((row) => <tr key={`${row.providerId}:${row.model}`} className="border-b border-line-soft last:border-0">
                <td className="px-4 py-2">{providers.find((provider) => provider.id === row.providerId)?.label ?? row.providerId}</td>
                <td className="break-all px-4 py-2">{row.model || 'Default'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.calls.toLocaleString()}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.inputTokens)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatTokens(row.outputTokens)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{row.costUsd === null ? 'Unknown' : usd(row.costUsd)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
      </Panel>
    </div>
  );
}
