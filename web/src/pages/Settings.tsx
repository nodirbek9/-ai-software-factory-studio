import { useEffect, useState, type FormEvent } from 'react';
import type { FsRoots, ProviderInfo, StudioSettings } from '@asf/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button, EmptyState, Field, Input, Panel, PanelHeader } from '@/components/ui/primitives';
import { api, post, setToken } from '@/lib/api';
import { useStudio } from '@/store/studio';

const EXECUTION_FIELDS = [
  { key: 'maxParallelTasks', label: 'Max parallel tasks', min: 1, max: 8 },
  { key: 'defaultMaxAttempts', label: 'Default max attempts', min: 1, max: 5 },
  { key: 'idleTimeoutMinutes', label: 'Stop an agent after this many minutes without activity', min: 2, max: 120 },
  { key: 'taskTimeoutMinutes', label: 'Longest single agent run (minutes)', min: 5, max: 480 },
  { key: 'maxFixRounds', label: 'Fix rounds per check', min: 0, max: 5 },
] as const;

function ExecutionForm({ settings, providers }: { settings: StudioSettings; providers: ProviderInfo[] }) {
  const [values, setValues] = useState(() => ({
    maxParallelTasks: String(settings.maxParallelTasks),
    defaultMaxAttempts: String(settings.defaultMaxAttempts),
    taskTimeoutMinutes: String(settings.taskTimeoutMinutes),
    idleTimeoutMinutes: String(settings.idleTimeoutMinutes ?? 15),
    maxFixRounds: String(settings.maxFixRounds ?? 2),
  }));
  const [order, setOrder] = useState(() => [...new Set(settings.fallbackOrder)]);
  const [included, setIncluded] = useState(() => [...settings.fallbackOrder]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const providerIds = [...new Set([...order, ...providers.map((provider) => provider.id)])];

  function move(id: string, direction: -1 | 1) {
    const next = [...providerIds];
    const index = next.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaved(false);
    const invalid = EXECUTION_FIELDS.find(({ key, min, max }) => {
      const value = Number(values[key]);
      return !Number.isInteger(value) || value < min || value > max;
    });
    if (invalid) {
      const message = `${invalid.label} must be a whole number from ${invalid.min} to ${invalid.max}.`;
      setValidation(message);
      useStudio.getState().setError(message);
      return;
    }
    setValidation(null);
    const next: StudioSettings = {
      maxParallelTasks: Number(values.maxParallelTasks),
      defaultMaxAttempts: Number(values.defaultMaxAttempts),
      taskTimeoutMinutes: Number(values.taskTimeoutMinutes),
      idleTimeoutMinutes: Number(values.idleTimeoutMinutes),
      maxFixRounds: Number(values.maxFixRounds),
      fallbackOrder: providerIds.filter((id) => included.includes(id)),
    };
    setSaving(true);
    useStudio.getState().setError(null);
    const previous = useStudio.getState().info?.settings;
    try {
      await useStudio.getState().updateSettings(next);
      const updated = useStudio.getState().info?.settings;
      // The store handles request errors internally; only a confirmed update is saved.
      setSaved(updated !== undefined && updated !== previous
        && EXECUTION_FIELDS.every(({ key }) => updated[key] === next[key])
        && JSON.stringify(updated.fallbackOrder) === JSON.stringify(next.fallbackOrder));
    } catch (error) {
      useStudio.getState().setError(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)} noValidate>
      <fieldset disabled={saving} className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {EXECUTION_FIELDS.map(({ key, label, min, max }) => {
            const value = Number(values[key]);
            const invalid = !Number.isInteger(value) || value < min || value > max;
            return (
              <Field key={key} label={label} hint={key === 'maxFixRounds' ? `Automatic fixes after red tests or a FAIL review, counted separately for each check (tests, security, review), ${min} to ${max} (0 = off).` : `Whole number from ${min} to ${max}.`}>
                <Input type="number" min={min} max={max} step={1} required value={values[key]}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [key]: event.target.value }));
                    setSaved(false);
                    setValidation(null);
                  }} />
              </Field>
            );
          })}
        </div>
        <div className="space-y-2">
          <h3 id="fallback-order-label" className="text-[12px] font-medium text-muted">Fallback order</h3>
          <p className="text-[12px] text-faint">Included providers are tried in this order when an agent allows fallback. Uncheck a provider to exclude it.</p>
          {providerIds.length ? (
            <ol aria-labelledby="fallback-order-label" className="space-y-2">
              {providerIds.map((id, index) => {
                const label = providers.find((provider) => provider.id === id)?.label ?? id;
                return (
                  <li key={id} className="flex items-center gap-3 rounded-md border border-line-soft bg-ink-950 px-3 py-2">
                    <span className="w-5 shrink-0 text-[12px] tabular-nums text-faint">{index + 1}.</span>
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input type="checkbox" className="accent-brand" checked={included.includes(id)} onChange={(event) => {
                        setIncluded((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id));
                        setSaved(false);
                      }} />
                      <span className="break-words">{label}</span>
                    </label>
                    <div className="flex shrink-0 gap-1">
                      <Button type="button" size="icon" variant="ghost" aria-label={`Move ${label} up`}
                        disabled={index === 0} onClick={() => move(id, -1)}><ArrowUp size={14} /></Button>
                      <Button type="button" size="icon" variant="ghost" aria-label={`Move ${label} down`}
                        disabled={index === providerIds.length - 1} onClick={() => move(id, 1)}><ArrowDown size={14} /></Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="text-[12px] text-muted">No providers are listed. Check Providers to configure availability.</p>}
        </div>
        {validation && <p role="alert" className="text-[12px] text-st-failed">{validation}</p>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          <span role="status" className="text-[12px] text-st-completed">{saved ? 'Saved' : ''}</span>
        </div>
      </fieldset>
    </form>
  );
}

export function Settings() {
  const { info, providers } = useStudio();
  const [roots, setRoots] = useState<FsRoots | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api<FsRoots>('/api/fs/roots', { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setRoots(value);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : 'Could not load approved folders.';
      setRootsError(message);
      useStudio.getState().setError(message);
    });
    return () => controller.abort();
  }, []);

  async function removeRoot(path: string) {
    if (removing) return;
    setRemoving(path);
    setRootsError(null);
    try {
      const result = await post<Pick<FsRoots, 'approvedRoots'>>('/api/fs/approved-roots/remove', { path });
      setRoots((value) => value && { ...value, ...result });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not remove the approved folder.';
      setRootsError(message);
      useStudio.getState().setError(message);
    } finally { setRemoving(null); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <h1 className="text-lg font-semibold">Settings</h1>
      {!info ? (
        <Panel><EmptyState title="Server information is unavailable">Check the studio connection to load settings.</EmptyState></Panel>
      ) : (
        <>
          <Panel className="shrink-0">
            <PanelHeader title="Execution" />
            <ExecutionForm settings={info.settings} providers={providers} />
          </Panel>
          <Panel className="shrink-0">
            <PanelHeader title="Server" />
            <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[140px_minmax(0,1fr)]">
              <dt className="text-muted">Address</dt><dd className="break-all font-mono">{info.host}:{info.port}</dd>
              <dt className="text-muted">Authentication</dt><dd>{info.authRequired ? 'Required' : 'Not required'}</dd>
              <dt className="text-muted">Data directory</dt><dd className="break-all font-mono">{info.dataDir}</dd>
              <dt className="text-muted">Approved folders</dt>
              <dd className="min-w-0 space-y-2">
                {!roots && !rootsError && <p role="status" className="text-muted">Loading folders…</p>}
                {roots && (roots.approvedRoots.length ? <ul className="space-y-2">{roots.approvedRoots.map((root) => (
                  <li key={root} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono">{root}</span>
                    <Button type="button" size="sm" disabled={removing !== null} aria-label={`Remove approved folder ${root}`}
                      onClick={() => void removeRoot(root)}>{removing === root ? 'Removing…' : 'Remove'}</Button>
                  </li>
                ))}</ul> : <p className="text-muted">No approved folders yet.</p>)}
                <p className="text-[12px] text-faint">Use Browse… when importing a project to approve a folder.</p>
                {rootsError && <p role="alert" className="text-[12px] text-st-failed">{rootsError}</p>}
              </dd>
              <dt className="text-muted">Protected paths</dt>
              <dd className="min-w-0 text-muted">
                {roots ? (roots.protectedPaths.length ? <ul className="space-y-1 font-mono">
                  {roots.protectedPaths.map((path) => <li key={path} className="break-all">{path}</li>)}
                </ul> : 'No protected paths listed.') : rootsError ? 'Unavailable.' : 'Loading…'}
              </dd>
              <dt className="text-muted">Version</dt><dd>{info.version}</dd>
            </dl>
          </Panel>
          <Panel className="shrink-0">
            <PanelHeader title="Command allowlist" />
            <div className="space-y-3 p-4">
              {info.allowedCommands.length ? <ul className="flex flex-wrap gap-2">{info.allowedCommands.map((command) => (
                <li key={command} className="max-w-full rounded-md border border-line bg-ink-950 px-2 py-1 font-mono text-[12px] break-all">{command}</li>
              ))}</ul> : <p className="text-muted">No commands are allowlisted.</p>}
              <p className="text-[12px] text-muted">Other commands need a per-project approval before they can run.</p>
            </div>
          </Panel>
          <Panel className="shrink-0">
            <PanelHeader title="Security" />
            <ul className="list-disc space-y-2 py-4 pr-4 pl-8 text-muted">
              <li>The studio binds to <code className="font-mono">127.0.0.1</code> by default.</li>
              <li>Remote access requires <code className="font-mono">ASF_AUTH_TOKEN</code>.</li>
              <li>Agents work in isolated git worktrees.</li>
              <li>The studio never pushes, resets or deletes branches.</li>
              <li>Secrets are redacted from logs.</li>
              <li>Chat cannot run commands.</li>
            </ul>
          </Panel>
          {info.authRequired && (
            <Panel className="shrink-0">
              <PanelHeader title="Access token" />
              <div className="p-4">
                <Button variant="danger" onClick={() => { setToken(null); window.location.reload(); }}>Sign out</Button>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
