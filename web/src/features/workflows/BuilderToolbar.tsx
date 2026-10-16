import { useId, useRef, type ReactNode } from 'react';
import { Archive, Check, Copy, Download, FlaskConical, Network, Pencil, Play, Plus, Redo2, Save, Undo2, Upload } from 'lucide-react';
import { Button, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import type { RunPanelTab } from './RunPanel';
import { runBlockReason, useWorkflows } from './workflowsStore';

export const BUILTIN_BANNER = 'Built-in template — Duplicate to edit';

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

function downloadText(fileName: string, text: string) {
  const link = document.createElement('a');
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const fileSlug = (name: string): string => name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'workflow';

/** A toolbar button that, when disabled, says why: as a tooltip and as accessible description. */
function Tool({ label, icon, onClick, disabledReason, variant, title }: {
  label: string; icon: ReactNode; onClick: () => void; disabledReason?: string | null; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; title?: string;
}) {
  const reasonId = useId();
  return (
    <span title={disabledReason ?? title} className="inline-flex">
      <Button variant={variant} disabled={Boolean(disabledReason)} onClick={onClick} aria-describedby={disabledReason ? reasonId : undefined}>
        {icon}{label}
      </Button>
      {disabledReason && <span id={reasonId} className="sr-only">{disabledReason}</span>}
    </span>
  );
}

function SaveStatus() {
  const dirty = useWorkflows((s) => s.editor?.dirty ?? false);
  const builtin = useWorkflows((s) => s.current?.builtin ?? false);
  const saving = useWorkflows((s) => s.saving);
  const info = useWorkflows((s) => s.saveInfo);
  const error = useWorkflows((s) => s.saveError);
  let text = '';
  let tone = 'text-faint';
  if (saving) text = 'Saving…';
  else if (error) { text = `Save failed: ${error}`; tone = 'text-st-failed'; }
  else if (dirty && !builtin) text = 'Unsaved changes';
  else if (info) text = `${info.kind === 'auto' ? 'Auto-saved' : 'Saved'} ${info.at}`;
  return <span role="status" aria-live="polite" className={cn('text-[12px]', tone)}>{text}</span>;
}

function WorkflowSelect() {
  const workflows = useWorkflows((s) => s.workflows);
  const currentId = useWorkflows((s) => s.current?.id ?? '');
  const templates = workflows.filter((item) => item.projectId === null);
  const own = workflows.filter((item) => item.projectId !== null);
  return (
    <Select aria-label="Workflow" className="w-64" value={currentId}
      onChange={(event) => { void useWorkflows.getState().selectWorkflow(event.target.value || null); }}>
      {!currentId && <option value="">Choose a workflow…</option>}
      {own.length > 0 && (
        <optgroup label="Project workflows">
          {own.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </optgroup>
      )}
      {templates.length > 0 && (
        <optgroup label="Templates">
          {templates.map((item) => <option key={item.id} value={item.id}>{item.name}{item.builtin ? ' (built-in)' : ''}</option>)}
        </optgroup>
      )}
    </Select>
  );
}

export function BuilderToolbar({ onShowTab }: { onShowTab: (tab: RunPanelTab) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const current = useWorkflows((s) => s.current);
  const editor = useWorkflows((s) => s.editor);
  const projectId = useWorkflows((s) => s.projectId);
  const validating = useWorkflows((s) => s.validating);
  const simulating = useWorkflows((s) => s.simulating);
  const saving = useWorkflows((s) => s.saving);
  const runReason = useWorkflows((s) => runBlockReason(s));
  const store = useWorkflows.getState;

  const builtin = current?.builtin ?? false;
  const dirty = editor?.dirty ?? false;
  const noWorkflow = current ? null : 'Choose a workflow first.';
  const readOnly = builtin ? 'Built-in templates are read-only. Duplicate it to edit.' : noWorkflow;

  const create = () => {
    const name = window.prompt('Name of the new workflow', 'New workflow')?.trim();
    if (name) void store().createWorkflow(name);
  };
  const rename = () => {
    const name = window.prompt('Rename workflow', current?.name ?? '')?.trim();
    if (name) void store().rename(name);
  };
  const archive = () => {
    if (current && window.confirm(`Archive "${current.name}"? It disappears from the list; runs that used it keep their snapshot.`)) void store().archive();
  };
  const exportJson = async () => {
    const result = await store().exportJson();
    if (result) downloadText(`${fileSlug(result.name)}.workflow.json`, result.json);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await store().importText(await readFileText(file));
    } catch (cause) {
      useWorkflows.setState({ actionError: `Import failed: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  };
  const run = async () => {
    if (await store().startRun()) onShowTab('timeline');
  };

  return (
    <div className="shrink-0 border-b border-line-soft">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-tight">Workflow Builder</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <WorkflowSelect />
            {current && (
              <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium',
                builtin ? 'border-line text-muted' : dirty ? 'border-st-waiting/40 text-st-waiting' : 'border-st-completed/40 text-st-completed')}>
                {builtin ? 'Built-in' : dirty ? 'Draft' : 'Saved'}
              </span>
            )}
            <SaveStatus />
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Tool label="New" icon={<Plus size={14} aria-hidden="true" />} onClick={create} disabledReason={projectId ? null : 'Select a project first.'} />
          <Tool label="Duplicate" icon={<Copy size={14} aria-hidden="true" />} onClick={() => void store().duplicate()} disabledReason={noWorkflow} />
          <Tool label="Rename" icon={<Pencil size={14} aria-hidden="true" />} onClick={rename} disabledReason={readOnly} />
          <Tool label="Archive" icon={<Archive size={14} aria-hidden="true" />} onClick={archive} disabledReason={readOnly} />
          <Tool label="Import" icon={<Upload size={14} aria-hidden="true" />} onClick={() => fileInput.current?.click()}
            disabledReason={projectId ? null : 'Select a project first.'} title="Import a workflow from a JSON file" />
          <input ref={fileInput} type="file" accept=".json,application/json" className="sr-only" aria-label="Import workflow file" tabIndex={-1}
            onChange={(event) => { const input = event.currentTarget; void importFile(input.files?.[0]).finally(() => { input.value = ''; }); }} />
          <Tool label="Export" icon={<Download size={14} aria-hidden="true" />} onClick={() => void exportJson()} disabledReason={noWorkflow} title="Download as JSON" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-4 py-2">
        <Tool label="Undo" icon={<Undo2 size={14} aria-hidden="true" />} variant="ghost" onClick={() => store().undo()}
          disabledReason={readOnly ?? (editor && editor.past.length > 0 ? null : 'Nothing to undo.')} />
        <Tool label="Redo" icon={<Redo2 size={14} aria-hidden="true" />} variant="ghost" onClick={() => store().redo()}
          disabledReason={readOnly ?? (editor && editor.future.length > 0 ? null : 'Nothing to redo.')} />
        <Tool label="Auto-layout" icon={<Network size={14} aria-hidden="true" />} variant="ghost" onClick={() => store().autoLayout()} disabledReason={readOnly} />
        <span className="mx-1 h-5 w-px bg-line-soft" aria-hidden="true" />
        <Tool label={validating ? 'Validating…' : 'Validate'} icon={<Check size={14} aria-hidden="true" />}
          onClick={() => { onShowTab('validation'); void store().validate(); }} disabledReason={noWorkflow ?? (validating ? 'Validation is running.' : null)} />
        <Tool label={simulating ? 'Simulating…' : 'Simulate'} icon={<FlaskConical size={14} aria-hidden="true" />}
          onClick={() => { onShowTab('simulation'); void store().simulate(); }}
          disabledReason={noWorkflow ?? (simulating ? 'Simulation is running.' : null)} title="Compile the workflow and list its tasks; nothing is started" />
        <span className="mx-1 h-5 w-px bg-line-soft" aria-hidden="true" />
        <Tool label="Save" icon={<Save size={14} aria-hidden="true" />} onClick={() => void store().save('manual')} title="Save (Ctrl+S)"
          disabledReason={readOnly ?? (saving ? 'Saving…' : dirty ? null : 'No unsaved changes.')} />
        <Tool label="Run" icon={<Play size={14} aria-hidden="true" />} variant="primary" onClick={() => void run()} disabledReason={runReason} />
      </div>
      {builtin && (
        <p role="status" className="flex items-center gap-3 border-t border-line-soft bg-brand/10 px-4 py-1.5 text-[12.5px]">
          <span>{BUILTIN_BANNER}</span>
          <Button size="sm" aria-label="Duplicate this template" onClick={() => void store().duplicate()}><Copy size={12} aria-hidden="true" /> Duplicate</Button>
        </p>
      )}
    </div>
  );
}
