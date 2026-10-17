import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import {
  EFFORT_LEVELS,
  WORKFLOW_LIMITS,
  type CatalogField,
  type NodeCatalogEntry,
  type ProviderInfo,
  type WorkflowIssue,
  type WorkflowNode,
} from '@asf/shared';
import { cn } from '@/lib/utils';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { deleteEdge, updateNode, type EditorState, type NodePatch } from './graphState';
import { NODE_ICON, nodeHue } from './WorkflowNodeCard';

interface Props {
  state: EditorState;
  catalog: NodeCatalogEntry[];
  /** Live provider list: the provider / model selects are built from it. */
  providers: ProviderInfo[];
  issues?: WorkflowIssue[];
  readOnly?: boolean;
  selectedEdgeId?: string | null;
  onChange: (state: EditorState) => void;
}

type ConfigPatch = Record<string, unknown>;

// ------------------------------------------------------------------ field editors

interface FieldProps {
  field: CatalogField;
  config: Record<string, unknown>;
  entry: NodeCatalogEntry;
  providers: ProviderInfo[];
  disabled: boolean;
  /** `typing` marks keystroke-level edits that share one undo step. */
  onPatch: (patch: ConfigPatch, typing?: boolean) => void;
  onBlur: () => void;
}

const asText = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

function TextEditor({ field, config, disabled, onPatch, onBlur }: FieldProps) {
  const value = asText(config[field.key] ?? field.default);
  const set = (next: string): void => onPatch({ [field.key]: next === '' ? undefined : next }, true);
  if (field.type === 'textarea') {
    return <Textarea rows={4} value={value} disabled={disabled} onChange={(event) => set(event.target.value)} onBlur={onBlur} />;
  }
  return <Input value={value} disabled={disabled} onChange={(event) => set(event.target.value)} onBlur={onBlur} />;
}

function NumberEditor({ field, config, disabled, onPatch, onBlur }: FieldProps) {
  const stored = config[field.key] ?? field.default;
  const [draft, setDraft] = useState(asText(stored));
  useEffect(() => setDraft(asText(stored)), [stored]);
  const clamp = (n: number): number => Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
  const inRange = (n: number): boolean => clamp(n) === n;
  const onType = (raw: string): void => {
    setDraft(raw);
    if (raw.trim() === '') return onPatch({ [field.key]: undefined }, true);
    const n = Number(raw);
    if (Number.isFinite(n) && inRange(n)) onPatch({ [field.key]: n }, true);
  };
  const onLeave = (): void => {
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n)) {
      if (clamp(n) !== stored) onPatch({ [field.key]: clamp(n) }, true);
      setDraft(String(clamp(n)));
    } else {
      setDraft(asText(stored));
    }
    onBlur();
  };
  return (
    <Input
      type="number"
      min={field.min}
      max={field.max}
      step={1}
      value={draft}
      disabled={disabled}
      onChange={(event) => onType(event.target.value)}
      onBlur={onLeave}
    />
  );
}

/** Options of a select, plus the current value when it is no longer in the list (so it stays visible). */
function withCurrent(options: { value: string; label: string }[], current: string): { value: string; label: string }[] {
  if (current === '' || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: `${current} (not available)` }];
}

function SelectEditor({ field, config, disabled, onPatch }: FieldProps) {
  const current = asText(config[field.key] ?? field.default);
  const base = (field.options ?? []).map((option) => ({ value: option.value, label: option.label }));
  const options = withCurrent(field.default === undefined ? [{ value: '', label: '— default —' }, ...base] : base, current);
  return (
    <Select value={current} disabled={disabled} onChange={(event) => onPatch({ [field.key]: event.target.value || undefined })}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}

const providerOf = (entry: NodeCatalogEntry, config: Record<string, unknown>): string =>
  asText(config[entry.fields.find((field) => field.type === 'provider')?.key ?? '']);

function ProviderEditor({ field, config, entry, providers, disabled, onPatch }: FieldProps) {
  const current = asText(config[field.key]);
  const modelKey = entry.fields.find((candidate) => candidate.type === 'model')?.key;
  const onSelect = (id: string): void => {
    const patch: ConfigPatch = { [field.key]: id || undefined };
    const models = providers.find((provider) => provider.id === id)?.models ?? [];
    if (modelKey && !models.includes(asText(config[modelKey]))) patch[modelKey] = undefined;
    onPatch(patch);
  };
  return (
    <Select value={current} disabled={disabled} onChange={(event) => onSelect(event.target.value)}>
      <option value="">Role default</option>
      {providers.map((provider) => {
        const usable = provider.enabled && provider.available;
        return (
          <option key={provider.id} value={provider.id} disabled={!usable && provider.id !== current}>
            {provider.label}{usable ? '' : provider.enabled ? ' (unavailable)' : ' (disabled)'}
          </option>
        );
      })}
      {current !== '' && !providers.some((provider) => provider.id === current) && <option value={current}>{current} (unknown)</option>}
    </Select>
  );
}

function ModelEditor({ field, config, entry, providers, disabled, onPatch }: FieldProps) {
  const current = asText(config[field.key]);
  const providerId = providerOf(entry, config);
  const models = providers.find((provider) => provider.id === providerId)?.models ?? [];
  const options = withCurrent(models.map((model) => ({ value: model, label: model })), current);
  return (
    <Select value={current} disabled={disabled || (providerId === '' && current === '')} onChange={(event) => onPatch({ [field.key]: event.target.value || undefined })}>
      <option value="">{providerId === '' ? 'Role default' : 'Provider default'}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}

function EffortEditor({ field, config, disabled, onPatch }: FieldProps) {
  const current = asText(config[field.key]);
  return (
    <Select value={current} disabled={disabled} onChange={(event) => onPatch({ [field.key]: event.target.value || undefined })}>
      <option value="">Default</option>
      {EFFORT_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
    </Select>
  );
}

function BooleanEditor({ field, config, disabled, onPatch }: FieldProps) {
  const checked = Boolean(config[field.key] ?? field.default ?? false);
  return (
    <label className="flex items-center gap-2 text-[13px] text-text">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onPatch({ [field.key]: event.target.checked })} />
      {field.label}
    </label>
  );
}

function ConfigField(props: FieldProps) {
  const { field } = props;
  let control: ReactNode;
  switch (field.type) {
    case 'number': control = <NumberEditor {...props} />; break;
    case 'select': control = <SelectEditor {...props} />; break;
    case 'provider': control = <ProviderEditor {...props} />; break;
    case 'model': control = <ModelEditor {...props} />; break;
    case 'effort': control = <EffortEditor {...props} />; break;
    case 'boolean': control = <BooleanEditor {...props} />; break;
    default: control = <TextEditor {...props} />;
  }
  if (field.type === 'boolean') {
    return <div className="space-y-1">{control}{field.help && <span className="block text-[11px] text-faint">{field.help}</span>}</div>;
  }
  return <Field label={field.label} hint={field.help}>{control}</Field>;
}

// ------------------------------------------------------------------ issues

function IssueList({ issues }: { issues: WorkflowIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Issues">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={cn('rounded-md border px-2 py-1 text-[12px]', issue.severity === 'error' ? 'border-st-failed/30 bg-st-failed/10 text-st-failed' : 'border-st-waiting/30 bg-st-waiting/10 text-st-waiting')}
        >
          <span className="font-medium">{issue.code}</span> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ panels

interface NodeFormProps {
  state: EditorState;
  node: WorkflowNode;
  entry: NodeCatalogEntry | undefined;
  providers: ProviderInfo[];
  issues: WorkflowIssue[];
  readOnly: boolean;
  onChange: (state: EditorState) => void;
}

function NodeForm({ state, node, entry, providers, issues, readOnly, onChange }: NodeFormProps) {
  // The field whose keystrokes are currently being merged into one undo step.
  const typing = useRef<string | null>(null);
  const edit = (patch: NodePatch, mergeKey?: string): void => {
    const next = updateNode(state, node.id, patch);
    if (next === state) return;
    const merge = mergeKey !== undefined && typing.current === mergeKey;
    typing.current = mergeKey ?? null;
    onChange(merge ? { ...next, past: state.past } : next);
  };
  const stopTyping = (): void => { typing.current = null; };
  const Icon = NODE_ICON[node.type];
  const hue = nodeHue(entry);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${hue} 18%, transparent)`, color: hue }}>
          <Icon size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-text">{entry?.label ?? node.type}</h3>
          <p className="text-[11px] text-faint">{node.id}</p>
        </div>
      </div>
      {entry && <p className="text-[12px] text-muted">{entry.description}</p>}
      {entry && !entry.executable && (
        <p className="rounded-md border border-line bg-ink-850 px-2 py-1 text-[12px] text-muted">Planned — {entry.plannedReason ?? 'not executable yet'}</p>
      )}
      <IssueList issues={issues} />
      <Field label="Label">
        <Input
          value={node.label ?? ''}
          maxLength={WORKFLOW_LIMITS.maxLabel}
          placeholder={entry?.label}
          disabled={readOnly}
          onChange={(event) => edit({ label: event.target.value }, `${node.id}:label`)}
          onBlur={stopTyping}
        />
      </Field>
      {entry?.fields.map((field) => (
        <ConfigField
          key={field.key}
          field={field}
          config={node.config}
          entry={entry}
          providers={providers}
          disabled={readOnly}
          onPatch={(config, isTyping) => edit({ config }, isTyping ? `${node.id}:${field.key}` : undefined)}
          onBlur={stopTyping}
        />
      ))}
    </div>
  );
}

function EdgePanel({ state, edgeId, issues, readOnly, onChange }: { state: EditorState; edgeId: string; issues: WorkflowIssue[]; readOnly: boolean; onChange: Props['onChange'] }) {
  const edge = state.graph.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return <p className="text-[12px] text-muted">This connection no longer exists.</p>;
  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold text-text">Connection</h3>
      <p className="text-[12px] text-muted">
        {edge.source}{edge.sourceHandle && edge.sourceHandle !== 'out' ? ` (${edge.sourceHandle})` : ''} → {edge.target}
        {edge.kind === 'retry' ? ' · retry loop' : ''}
      </p>
      <IssueList issues={issues} />
      <Button variant="danger" size="sm" disabled={readOnly} onClick={() => onChange(deleteEdge(state, edge.id))}>
        <Trash2 size={13} aria-hidden /> Delete connection
      </Button>
    </div>
  );
}

function GraphSummary({ state, issues }: { state: EditorState; issues: WorkflowIssue[] }) {
  const general = issues.filter((issue) => !issue.nodeId && !issue.edgeId);
  return (
    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold text-text">Workflow</h3>
      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        <div className="rounded-md border border-line-soft bg-ink-850 px-2 py-1.5"><dt className="text-faint">Nodes</dt><dd className="text-[15px] font-semibold text-text">{state.graph.nodes.length}</dd></div>
        <div className="rounded-md border border-line-soft bg-ink-850 px-2 py-1.5"><dt className="text-faint">Connections</dt><dd className="text-[15px] font-semibold text-text">{state.graph.edges.length}</dd></div>
      </dl>
      <IssueList issues={general} />
      <p className="text-[12px] text-muted">Select a node or a connection to edit it. Drag nodes from the palette onto the canvas, then connect their handles.</p>
    </div>
  );
}

export function NodeInspector({ state, catalog, providers, issues = [], readOnly = false, selectedEdgeId = null, onChange }: Props) {
  const lockNote = readOnly ? <p className="rounded-md border border-line bg-ink-850 px-2 py-1 text-[12px] text-muted">Read-only — duplicate this workflow to edit it.</p> : null;
  let body: ReactNode;
  if (state.selection.length > 1) {
    body = <p className="text-[12px] text-muted">{state.selection.length} nodes selected. Select a single node to edit it.</p>;
  } else if (state.selection.length === 1) {
    const node = state.graph.nodes.find((candidate) => candidate.id === state.selection[0]);
    body = node ? (
      <NodeForm
        key={node.id}
        state={state}
        node={node}
        entry={catalog.find((candidate) => candidate.type === node.type)}
        providers={providers}
        issues={issues.filter((issue) => issue.nodeId === node.id)}
        readOnly={readOnly}
        onChange={onChange}
      />
    ) : null;
  } else if (selectedEdgeId) {
    body = <EdgePanel state={state} edgeId={selectedEdgeId} issues={issues.filter((issue) => issue.edgeId === selectedEdgeId)} readOnly={readOnly} onChange={onChange} />;
  } else {
    body = <GraphSummary state={state} issues={issues} />;
  }
  return (
    <div className="space-y-3 overflow-y-auto p-3" aria-label="Inspector">
      {lockNote}
      {body}
    </div>
  );
}
