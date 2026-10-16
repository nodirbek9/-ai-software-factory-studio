import { useEffect, useMemo, useState } from 'react';
import { AGENT_ROLES, AGENT_ROLE_INFO, EFFORT_LEVELS, type AgentRole, type AgentSession, type CreateSessionInput, type EffortLevel, type ProviderInfo } from '@asf/shared';
import { Button, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useStudio } from '@/store/studio';
import { useSessions } from './sessionsStore';

/** Roles that review or plan default to read-only; roles that write code default to their own worktree. */
export const EDIT_BY_DEFAULT: ReadonlySet<AgentRole> = new Set<AgentRole>(['backend', 'frontend', 'qa']);

const usable = (provider: ProviderInfo) => provider.enabled && provider.available;

function unusableReason(provider: ProviderInfo): string {
  if (!provider.enabled) return 'disabled in Models & Providers';
  return `unavailable${provider.reason ? `: ${provider.reason}` : ''}`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: AgentSession) => void;
}

function Form({ onCreated, onClose }: { onCreated: (session: AgentSession) => void; onClose: () => void }) {
  const providers = useStudio((s) => s.providers);
  const agentConfigs = useStudio((s) => s.agentConfigs);
  const tasks = useStudio((s) => s.snapshot?.tasks ?? []);

  const initialRole: AgentRole = 'backend';
  const pick = (role: AgentRole) => {
    const configured = agentConfigs.find((c) => c.role === role);
    const provider = providers.find((p) => p.id === configured?.providerId && usable(p)) ?? providers.find(usable);
    const model = configured && provider?.id === configured.providerId && configured.model ? configured.model : provider?.defaultModel ?? '';
    return { providerId: provider?.id ?? '', model, effort: (configured && provider?.id === configured.providerId ? configured.effort : '') as EffortLevel };
  };

  const [role, setRole] = useState<AgentRole>(initialRole);
  const [{ providerId, model, effort }, setChoice] = useState(() => pick(initialRole));
  const [mode, setMode] = useState<CreateSessionInput['mode']>(EDIT_BY_DEFAULT.has(initialRole) ? 'edit' : 'readonly');
  const [title, setTitle] = useState('');
  const [taskId, setTaskId] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === providerId);
  const canEdit = provider?.editsFiles ?? false;
  const effectiveMode = mode === 'edit' && !canEdit ? 'readonly' : mode;
  const models = useMemo(() => provider?.models ?? [], [provider]);

  // Defaults follow the role (and a late provider load); the user's later choices are never overwritten.
  useEffect(() => {
    if (!providerId) setChoice(pick(role));
  }, [providers.length, agentConfigs.length]);

  const onRole = (next: AgentRole) => {
    setRole(next);
    setChoice(pick(next));
    setMode(EDIT_BY_DEFAULT.has(next) ? 'edit' : 'readonly');
    setCustomModel(false);
  };

  const onProvider = (id: string) => {
    const next = providers.find((p) => p.id === id);
    setChoice({ providerId: id, model: next?.defaultModel ?? '', effort });
    setCustomModel(false);
  };

  const submit = async () => {
    const input: CreateSessionInput = { role, providerId, model, effort, mode: effectiveMode };
    if (title.trim()) input.title = title.trim();
    if (taskId) input.taskId = taskId;
    setSaving(true);
    setError(null);
    try {
      const session = await useSessions.getState().createSession(input);
      onCreated(session);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label="Title (optional)">
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${AGENT_ROLE_INFO[role].name} session`} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Role">
          <Select value={role} onChange={(event) => onRole(event.target.value as AgentRole)}>
            {AGENT_ROLES.map((item) => <option key={item} value={item}>{AGENT_ROLE_INFO[item].name}</option>)}
          </Select>
        </Field>
        <Field label="Provider">
          <Select value={providerId} onChange={(event) => onProvider(event.target.value)} required>
            <option value="" disabled>Select a provider</option>
            {providers.map((item) => (
              <option key={item.id} value={item.id} disabled={!usable(item)}>
                {item.label}{usable(item) ? '' : ` — ${unusableReason(item)}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">Model</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Model">
          {models.map((name) => (
            <button key={name} type="button" role="radio" aria-checked={!customModel && model === name}
              onClick={() => { setChoice({ providerId, model: name, effort }); setCustomModel(false); }}
              className={cn('rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                !customModel && model === name ? 'border-brand bg-brand/15 text-text' : 'border-line text-muted hover:border-faint hover:text-text')}>
              {name}{name === provider?.defaultModel ? ' (default)' : ''}
            </button>
          ))}
          {provider && (
            <button type="button" role="radio" aria-checked={customModel} onClick={() => setCustomModel(true)}
              className={cn('rounded-md border px-2.5 py-1 text-[12px]', customModel ? 'border-brand bg-brand/15 text-text' : 'border-dashed border-line text-muted hover:text-text')}>
              Other…
            </button>
          )}
        </div>
        {customModel && (
          <Input autoFocus aria-label="Custom model id" placeholder="Exact model id" value={model}
            onChange={(event) => setChoice({ providerId, model: event.target.value, effort })} />
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reasoning effort">
          <Select value={effort} onChange={(event) => setChoice({ providerId, model, effort: event.target.value as EffortLevel })}>
            <option value="">Provider default</option>
            {EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </Select>
        </Field>
        <Field label="Linked task (optional)">
          <Select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">None</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </Select>
        </Field>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">Mode</span>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Mode">
          <button type="button" role="radio" aria-checked={effectiveMode === 'readonly'} onClick={() => setMode('readonly')}
            className={cn('rounded-md border p-2.5 text-left text-[12.5px]', effectiveMode === 'readonly' ? 'border-brand bg-brand/10' : 'border-line hover:border-faint')}>
            <span className="block font-medium">Read-only</span>
            <span className="text-[11.5px] text-muted">Works in the integration worktree and cannot change files.</span>
          </button>
          <button type="button" role="radio" aria-checked={effectiveMode === 'edit'} disabled={!canEdit}
            title={canEdit ? undefined : provider ? `${provider.label} cannot edit files` : 'Select a provider first'}
            onClick={() => setMode('edit')}
            className={cn('rounded-md border p-2.5 text-left text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50', effectiveMode === 'edit' ? 'border-brand bg-brand/10' : 'border-line hover:border-faint')}>
            <span className="block font-medium">Edit in own worktree</span>
            <span className="text-[11.5px] text-muted">Own branch and worktree; reaches the project only through an explicit merge.</span>
          </button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md border border-st-failed/40 bg-st-failed/10 px-2.5 py-1.5 text-[12.5px] text-st-failed">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving || !providerId || !model.trim()}>{saving ? 'Creating…' : 'Create session'}</Button>
      </div>
    </form>
  );
}

export function NewSessionDialog({ open, onOpenChange, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New session"
      description="A session is a conversation with one agent. It starts no process until you send a message.">
      {/* Mounted only while open, so every opening starts from fresh defaults. */}
      {open && <Form onCreated={onCreated} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}
