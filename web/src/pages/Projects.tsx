import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { CreateProjectInput, DirListing } from '@asf/shared';
import { FolderOpen, FolderPlus, Plus, Sparkles, Trash2 } from 'lucide-react';
import { FolderPicker } from '@/components/FolderPicker';
import { Markdown } from '@/components/Markdown';
import { Button, Dialog, EmptyState, Field, Input, Panel, PanelHeader, Select, StatusBadge, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { useStudio } from '@/store/studio';

const WORKSPACE_MODES = [
  { id: 'new', label: 'New empty workspace' },
  { id: 'sample', label: 'Sample project' },
  { id: 'import', label: 'Import local repository' },
] as const;
const TABS = [
  { id: 'spec', label: 'Specification' },
  { id: 'planMarkdown', label: 'Technical plan' },
  { id: 'reportMarkdown', label: 'Delivery report' },
] as const;
type Sample = { name: string; spec: string };

export function Projects() {
  const { projects, currentProjectId, snapshot, info, createProject, selectProject, setView, startPlanning } = useStudio();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<CreateProjectInput['workspaceMode']>('new');
  const [importPath, setImportPath] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importListing, setImportListing] = useState<DirListing | null>(null);
  const [importStrategy, setImportStrategy] = useState<'worktree' | 'copy'>('copy');
  const [importChecking, setImportChecking] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sampleName, setSampleName] = useState('');
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [spec, setSpec] = useState('');
  const [testCommand, setTestCommand] = useState('npm test');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('spec');
  const project = snapshot?.project.id === currentProjectId
    ? snapshot.project : projects.find((item) => item.id === currentProjectId);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSamplesLoading(true);
    setSamplesError(null);
    void api<Sample[]>('/api/samples', { signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setSamples(items); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : 'Could not load samples.';
        setSamplesError(message);
        useStudio.getState().setError(message);
      })
      .finally(() => { if (!controller.signal.aborted) setSamplesLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open || mode !== 'import' || !importPath.trim() || importListing?.path === importPath.trim()) return;
    const controller = new AbortController();
    setImportChecking(true);
    setImportError(null);
    const timer = window.setTimeout(() => {
      void api<DirListing>(`/api/fs/list?path=${encodeURIComponent(importPath.trim())}`, { signal: controller.signal })
        .then((listing) => {
          if (controller.signal.aborted) return;
          setImportPath(listing.path);
          setImportListing(listing);
          setImportStrategy(listing.isGitRepo ? 'worktree' : 'copy');
          setImportChecking(false);
        }).catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          const message = cause instanceof Error ? cause.message : 'Could not check the import folder.';
          setImportError(message);
          useStudio.getState().setError(message);
          setImportChecking(false);
        });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, mode, importPath, importListing]);

  function showError(message: string) {
    setError(message);
    useStudio.getState().setError(message);
  }

  function uploadRequirements(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.(md|txt|markdown)$/i.test(file.name)) {
      showError('Choose a .md, .txt or .markdown file.');
      return;
    }
    if (file.size > 1024 * 1024) {
      showError('Requirements must be no larger than 1 MB.');
      return;
    }
    setError(null);
    setReadingFile(true);
    const reader = new FileReader();
    reader.onload = () => { setSpec(String(reader.result ?? '')); };
    reader.onerror = () => showError(reader.error?.message ?? 'Could not read the requirements file.');
    reader.onloadend = () => setReadingFile(false);
    reader.readAsText(file);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || readingFile) return;
    setError(null);
    if (!name.trim()) { showError('Enter a project name.'); return; }
    if (mode === 'sample' && !sampleName) { showError('Choose a sample project.'); return; }
    if (mode === 'import' && !importPath.trim()) { showError('Enter an absolute repository path.'); return; }
    if (mode === 'import' && (importChecking || importError || !importListing)) { showError('Choose a valid folder before importing.'); return; }
    setSubmitting(true);
    try {
      await createProject({
        name: name.trim(), description: description.trim(), spec, workspaceMode: mode,
        ...(mode === 'sample' ? { sampleName } : {}),
        ...(mode === 'import' ? { importPath: importPath.trim(), importStrategy } : {}),
        testCommand: testCommand.trim(),
      });
      setOpen(false);
      setName('');
      setDescription('');
      setSpec('');
      setMode('new');
      setSampleName('');
      setImportPath('');
      setImportListing(null);
      setImportStrategy('copy');
      setImportError(null);
      setImportChecking(false);
      setTestCommand('npm test');
      setView('dashboard');
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : 'Could not create the project.');
    } finally {
      setSubmitting(false);
    }
  }

  async function generatePlan() {
    setPlanning(true);
    try { await startPlanning(); }
    catch (cause) { useStudio.getState().setError(cause instanceof Error ? cause.message : 'Could not generate the plan.'); }
    finally { setPlanning(false); }
  }

  const newProject = () => { setError(null); setOpen(true); };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button variant="primary" onClick={newProject}><Plus size={15} />New project</Button>
      </div>

      {!projects.length ? (
        <Panel>
          <EmptyState icon={<FolderPlus size={28} />} title="No projects yet">
            <p>Create a workspace from a specification, try a sample or import a local repository.</p>
            <Button variant="primary" className="mt-4" onClick={newProject}>New project</Button>
          </EmptyState>
        </Panel>
      ) : (
        <div className="flex flex-col gap-3" aria-label="Projects">
          {projects.map((item) => (
            <Panel key={item.id} className={cn('overflow-hidden', item.id === currentProjectId && 'border-brand/60')}>
              <button type="button" aria-pressed={item.id === currentProjectId}
                className="block w-full min-w-0 p-4 text-left transition-colors hover:bg-ink-800/60"
                onClick={() => { setTab('spec'); void selectProject(item.id); }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-sm font-semibold">{item.name}</span>
                  <StatusBadge status={item.status} />
                  <span className="text-[12px] text-muted">{WORKSPACE_MODES.find((entry) => entry.id === item.workspaceMode)?.label}</span>
                  <span className="ml-auto text-[12px] text-faint" title={item.createdAt}>Created {timeAgo(item.createdAt)}</span>
                </div>
                <div className="mt-2 truncate font-mono text-[12px] text-muted" title={item.workspacePath}>{item.workspacePath}</div>
                <div className="mt-1 truncate text-[12px] text-faint" title={item.integrationBranch ?? undefined}>
                  Integration branch: <span className="font-mono">{item.integrationBranch ?? 'Not created yet'}</span>
                </div>
              </button>
            </Panel>
          ))}
        </div>
      )}

      {project && projects.length > 0 && (
        <Panel className="shrink-0 overflow-hidden">
          <PanelHeader title={project.name}>
            <div className="flex flex-wrap justify-end gap-2">
              {project.status === 'draft' && (
                <Button disabled={planning || snapshot?.project.id !== project.id} onClick={() => void generatePlan()}>
                  <Sparkles size={14} />{planning ? 'Generating plan…' : 'Generate plan'}
                </Button>
              )}
              <Button variant="primary" onClick={async () => { await selectProject(project.id); setView('dashboard'); }}>Open in dashboard</Button>
              <Button variant="danger" disabled={['planning', 'running', 'awaiting_approval'].includes(project.status)}
                title={['planning', 'running', 'awaiting_approval'].includes(project.status) ? 'Stop the project first' : 'Delete this project'}
                onClick={() => {
                  const where = info && !project.workspacePath.toLowerCase().startsWith(info.dataDir.toLowerCase())
                    ? 'Your repository folder is kept; only the studio worktrees are removed (asf/* branches stay for you to delete).'
                    : 'Its studio workspace folder and worktrees are deleted.';
                  if (window.confirm(`Delete "${project.name}"? ${where} This cannot be undone.`)) void useStudio.getState().deleteProject(project.id);
                }}>
                <Trash2 size={14} /> Delete
              </Button>
            </div>
          </PanelHeader>
          <div role="tablist" aria-label="Project details" className="flex gap-1 overflow-x-auto border-b border-line-soft px-4 pt-2">
            {TABS.map((item, index) => (
              <button key={item.id} type="button" id={`project-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
                aria-controls="project-detail-panel" tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
                  else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = TABS.length - 1;
                  else return;
                  event.preventDefault();
                  setTab(TABS[next].id);
                  document.getElementById(`project-tab-${TABS[next].id}`)?.focus();
                }}
                className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-[13px]', tab === item.id ? 'border-brand text-text' : 'border-transparent text-muted hover:text-text')}>
                {item.label}
              </button>
            ))}
          </div>
          <div id="project-detail-panel" role="tabpanel" aria-labelledby={`project-tab-${tab}`} tabIndex={0} className="min-w-0 overflow-x-auto p-4">
            {project[tab]?.trim() ? <Markdown>{project[tab]!}</Markdown> : (
              <EmptyState title={tab === 'planMarkdown' ? 'No technical plan yet' : tab === 'reportMarkdown' ? 'No delivery report yet' : 'No specification yet'}>
                {tab === 'planMarkdown' ? 'Generate a plan to review the proposed implementation.'
                  : tab === 'reportMarkdown' ? 'The delivery report will appear when the project run produces it.' : 'This project has no saved specification.'}
              </EmptyState>
            )}
          </div>
        </Panel>
      )}

      <Dialog open={open} onOpenChange={(value) => { if (!submitting && !readingFile) setOpen(value); }} title="New project" wide
        description="Choose a workspace and describe what the team should build.">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <fieldset disabled={submitting || readingFile} className="min-w-0 space-y-4">
            <Field label="Name"><Input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" /></Field>
            <Field label="Description"><Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A short overview" /></Field>
            <fieldset className="min-w-0">
              <legend className="mb-1 text-xs font-medium text-muted">Workspace type</legend>
              <div className="flex flex-wrap gap-1 rounded-md border border-line bg-ink-950 p-1">
                {WORKSPACE_MODES.map((item) => (
                  <Button key={item.id} type="button" variant={mode === item.id ? 'primary' : 'ghost'} aria-pressed={mode === item.id}
                    className="flex-1" onClick={() => setMode(item.id)}>{item.label}</Button>
                ))}
              </div>
            </fieldset>
            {mode === 'sample' && (
              <div className="space-y-2">
                <Field label="Sample project" hint="The sample runs on the offline scripted provider unless AI providers are assigned.">
                  <Select required value={sampleName} disabled={samplesLoading || !!samplesError} onChange={(event) => {
                    setSampleName(event.target.value);
                    const sample = samples.find((item) => item.name === event.target.value);
                    if (sample) setSpec(sample.spec);
                  }}>
                    <option value="">{samplesLoading ? 'Loading samples…' : 'Choose a sample'}</option>
                    {samples.map((sample) => <option key={sample.name} value={sample.name}>{sample.name}</option>)}
                  </Select>
                </Field>
                {samplesError && <p role="alert" className="text-[12px] text-st-failed">{samplesError}</p>}
                {!samplesLoading && !samplesError && !samples.length && <p className="text-[12px] text-muted">No samples are available.</p>}
              </div>
            )}
            {mode === 'import' && (
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="Absolute repository path">
                      <Input required value={importPath} onChange={(event) => {
                        setImportPath(event.target.value);
                        setImportListing(null);
                        setImportStrategy('copy');
                        setImportError(null);
                        setImportChecking(!!event.target.value.trim());
                      }} className="font-mono" placeholder="Absolute path to your repository" />
                    </Field>
                  </div>
                  <Button type="button" onClick={() => setPickerOpen(true)}><FolderOpen size={15} />Browse…</Button>
                </div>
                <p className="text-[11px] text-faint">Pick a folder with Browse…; approve it once. Your original folder is never modified in copy mode; in branch mode the studio only adds its own asf/* branch.</p>
                <fieldset className="space-y-2" disabled={importChecking}>
                  <legend className="mb-1 text-xs font-medium text-muted">Import method</legend>
                  <div className="flex flex-wrap gap-2">
                    <label className={cn('flex items-center gap-2 rounded-md border px-3 py-2', importStrategy === 'worktree' ? 'border-brand bg-ink-800' : 'border-line', !importListing?.isGitRepo && 'text-faint')}>
                      <input type="radio" name="importStrategy" value="worktree" className="accent-brand" checked={importStrategy === 'worktree'}
                        disabled={!importListing?.isGitRepo} aria-describedby={!importListing?.isGitRepo ? 'worktree-hint' : undefined}
                        onChange={() => setImportStrategy('worktree')} />Work on a branch in this git repo
                    </label>
                    <label className={cn('flex items-center gap-2 rounded-md border px-3 py-2', importStrategy === 'copy' ? 'border-brand bg-ink-800' : 'border-line')}>
                      <input type="radio" name="importStrategy" value="copy" className="accent-brand" checked={importStrategy === 'copy'}
                        onChange={() => setImportStrategy('copy')} />Copy into the studio
                    </label>
                  </div>
                  {!importListing?.isGitRepo && <p id="worktree-hint" className="text-[11px] text-faint">Branch mode requires a git repository. Other folders must be copied.</p>}
                </fieldset>
                {importChecking && <p role="status" className="text-[12px] text-muted">Checking folder…</p>}
                {importError && <p role="alert" className="text-[12px] text-st-failed">{importError}</p>}
              </div>
            )}
            <Field label="Specification"><Textarea rows={12} className="font-mono" value={spec} onChange={(event) => setSpec(event.target.value)} placeholder="Describe requirements, expected behavior and acceptance criteria…" /></Field>
            <Field label="Upload requirements" hint="Choose a .md, .txt or .markdown file, up to 1 MB. Its text replaces the specification.">
              <Input type="file" accept=".md,.txt,.markdown" onChange={uploadRequirements} className="h-auto py-1.5" />
            </Field>
            <Field label="Test command" hint={info?.allowedCommands.length ? `Allowed commands include: ${info.allowedCommands.slice(0, 5).join(', ')}` : 'Allowed commands will appear when server information is available.'}>
              <Input value={testCommand} onChange={(event) => setTestCommand(event.target.value)} className="font-mono" />
            </Field>
          </fieldset>
          {error && <p role="alert" className="text-[13px] text-st-failed">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" disabled={submitting || readingFile} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={submitting || readingFile || (mode === 'sample' && (samplesLoading || !sampleName || !!samplesError)) || (mode === 'import' && (importChecking || !!importError || !importListing))}>
              {submitting ? 'Creating project…' : readingFile ? 'Reading requirements…' : 'Create project'}
            </Button>
          </div>
        </form>
        <FolderPicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={(listing) => {
          setImportPath(listing.path);
          setImportListing(listing);
          setImportStrategy(listing.isGitRepo ? 'worktree' : 'copy');
          setImportError(null);
          setImportChecking(false);
        }} />
      </Dialog>
    </div>
  );
}
