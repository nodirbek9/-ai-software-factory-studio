import { useEffect, useState } from 'react';
import { AGENT_ROLES, AGENT_ROLE_INFO, EFFORT_LEVELS, type AgentConfig, type AgentRole, type AgentTestResult, type AgentView, type EffortLevel, type ProviderInfo } from '@asf/shared';
import { ROLE_HUE, ROLE_ICON } from '@/components/agentMeta';
import { Button, Field, Input, Panel, Select, StatusBadge } from '@/components/ui/primitives';
import { useStudio } from '@/store/studio';
import { cn } from '@/lib/utils';

function AgentTestStatus({ result }: { result: AgentTestResult }) {
  return <div role="status" className="space-y-1 break-words text-[12px]">
    {result.ok ? <p className={result.correct ? 'text-st-completed' : 'text-st-waiting'}>
      {result.correct ? '✓' : '✗'} {result.actualModel ?? 'Model not reported'} ({result.providerLabel})
      {' · '}effort {result.effort || 'default'} · {result.reasoningTokens ?? 'unknown'} thinking tokens
      {' · '}answer {result.answer || '(empty)'} · {(result.durationMs / 1000).toFixed(1)} s
    </p> : <p className="text-st-failed">{result.error}</p>}
    {result.actualModel && result.actualModel !== result.requestedModel && <p className="text-st-waiting">
      asked for {result.requestedModel}, got {result.actualModel}
    </p>}
    {!result.effortApplied && <p className="text-muted">effort not supported by this provider</p>}
  </div>;
}

function AgentEditor({ role, config, providers, agent }: {
  role: AgentRole; config?: AgentConfig; providers: ProviderInfo[]; agent?: AgentView;
}) {
  const [providerId, setProviderId] = useState(config?.providerId ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [allowFallback, setAllowFallback] = useState(config?.allowFallback ?? false);
  const [effort, setEffort] = useState<EffortLevel>(config?.effort ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const testing = useStudio((state) => state.testingAgents[role] ?? false);
  const testResult = useStudio((state) => state.agentTests[role]);
  const testError = useStudio((state) => state.agentTestErrors[role]);
  const dirty = !config || providerId !== config.providerId || model !== config.model
    || effort !== config.effort || allowFallback !== config.allowFallback;
  useEffect(() => {
    setProviderId(config?.providerId ?? '');
    setModel(config?.model ?? '');
    setAllowFallback(config?.allowFallback ?? false);
    setEffort(config?.effort ?? '');
  }, [config?.providerId, config?.model, config?.allowFallback, config?.effort]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const provider = providers.find((item) => item.id === providerId);
  // Free-text model ids only when the user asks for "Other…" or the saved model is not in the provider's list.
  const [customModel, setCustomModel] = useState(false);
  useEffect(() => {
    setCustomModel(Boolean(provider && model && !provider.models.includes(model)));
  }, [config?.model, provider?.id]);
  const Icon = ROLE_ICON[role];
  const info = AGENT_ROLE_INFO[role];
  const save = async () => {
    setSaving(true);
    setSaved(false);
    useStudio.getState().setError(null);
    try {
      await useStudio.getState().updateAgentConfig(role, { providerId, model, allowFallback, effort });
      if (!useStudio.getState().error) setSaved(true);
    } catch (error) {
      useStudio.getState().setError(error instanceof Error ? error.message : 'Could not save agent configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2.5">
        <Icon size={20} className="mt-0.5 shrink-0" style={{ color: ROLE_HUE[role] }} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{info.name}</h2>
          <p className="text-[12px] text-muted">{info.title}</p>
        </div>
        {agent && <StatusBadge status={agent.status} />}
      </div>
      <p className="text-[12px] text-muted">{info.description}</p>
      {agent && <p className="text-[12px] text-muted">Verified tasks <span className="tabular-nums text-text">{agent.tasksCompleted}/{agent.tasksTotal}</span></p>}
      <form className="mt-auto space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={saving} className="space-y-3">
          <Field label="Provider">
            <Select value={providerId} required onChange={(event) => {
              const next = providers.find((item) => item.id === event.target.value);
              setProviderId(event.target.value);
              // Switching provider: keep the model if the new provider offers it, otherwise pick its default.
              if (next && !next.models.includes(model)) setModel(next.defaultModel);
              setCustomModel(false);
              setSaved(false);
            }}>
              <option value="" disabled>Select a provider</option>
              {providerId && !provider && <option value={providerId}>{providerId} (unavailable)</option>}
              {providers.map((item) => <option key={item.id} value={item.id}>
                {item.label}{!item.enabled ? ' (disabled)' : ''}{!item.available ? ' (unavailable)' : ''}
              </option>)}
            </Select>
          </Field>
          {provider && (!provider.enabled || !provider.available) && (
            <div role="alert" className="space-y-2 rounded-lg border border-st-waiting/40 bg-st-waiting/10 p-2.5 text-[12px] text-st-waiting">
              <p>
                {provider.label} is {!provider.enabled ? 'disabled' : `unavailable (${provider.reason ?? 'not detected'})`}, so this agent
                {allowFallback ? ' runs on the next provider in the fallback order instead.' : ' cannot run.'}
              </p>
              {!provider.enabled && provider.available && (
                <Button type="button" size="sm" onClick={() => void useStudio.getState().updateProvider(provider.id, { enabled: true })}>
                  Enable {provider.label}
                </Button>
              )}
            </div>
          )}
          {provider && model && !provider.models.includes(model) && (
            <p className="text-[12px] text-st-waiting">“{model}” is not one of {provider.label}'s known models — check the spelling.</p>
          )}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">Model</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${info.name} model`}>
              {(provider?.models ?? []).map((name) => (
                <button key={name} type="button" role="radio" aria-checked={!customModel && model === name}
                  onClick={() => { setModel(name); setCustomModel(false); setSaved(false); }}
                  className={cn('rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                    !customModel && model === name ? 'border-brand bg-brand/15 text-text' : 'border-line text-muted hover:border-faint hover:text-text')}>
                  {name}{name === provider?.defaultModel ? ' (default)' : ''}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={customModel} onClick={() => { setCustomModel(true); setSaved(false); }}
                className={cn('rounded-md border px-2.5 py-1 text-[12px]', customModel ? 'border-brand bg-brand/15 text-text' : 'border-dashed border-line text-muted hover:text-text')}>
                Other…
              </button>
            </div>
            {customModel && (
              <Input autoFocus placeholder="Exact model id, e.g. claude-opus-5-5" value={model} aria-label="Custom model id"
                onChange={(event) => { setModel(event.target.value); setSaved(false); }} />
            )}
          </div>
          <Field label="Reasoning effort" hint="Claude Code: --effort; Codex: model_reasoning_effort; Antigravity/Gemini ignore it.">
            <Select value={effort} onChange={(event) => { setEffort(event.target.value as EffortLevel); setSaved(false); }}>
              <option value="">Provider default</option>
              {EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-[12px] text-muted">
            <input type="checkbox" className="mt-0.5 accent-brand" checked={allowFallback}
              onChange={(event) => { setAllowFallback(event.target.checked); setSaved(false); }} />
            Fall back to other providers when unavailable
          </label>
        </fieldset>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={saving || !providerId}>{saving ? 'Saving…' : 'Save'}</Button>
          <Button type="button" disabled={testing || saving || dirty}
            onClick={() => void useStudio.getState().testAgent(role)}>{testing ? 'Testing…' : 'Test'}</Button>
          <span role="status" className="text-[12px] text-st-completed">{saved ? 'Saved' : ''}</span>
        </div>
        {dirty && <p className="text-[12px] text-muted">Save first — the test uses the saved settings</p>}
        {testError && <p role="alert" className="text-[12px] text-st-failed">{testError}</p>}
        {testResult && <AgentTestStatus result={testResult} />}
      </form>
    </Panel>
  );
}

export function Agents() {
  const { agentConfigs, providers, snapshot } = useStudio();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <h1 className="text-lg font-semibold">Agents</h1>
      <p className="text-muted">Each agent tries its assigned provider first. When fallback is enabled, it then follows the fallback order in Settings.
        {' '}The Scripted provider is not AI and only replays sample scripts.</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {AGENT_ROLES.map((role) => <AgentEditor key={role} role={role} providers={providers}
          config={agentConfigs.find((config) => config.role === role)} agent={snapshot?.agents.find((agent) => agent.role === role)} />)}
      </div>
    </div>
  );
}
