import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AlertCircle, FolderGit2, Plus, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { RunNodeStatus, WorkflowNodeType } from '@asf/shared';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives';
import { hashParam, useStudio, viewFromHash } from '@/store/studio';
import { BuilderToolbar } from '@/features/workflows/BuilderToolbar';
import { NodeInspector } from '@/features/workflows/NodeInspector';
import { NodePalette } from '@/features/workflows/NodePalette';
import { RunPanel, type RunPanelTab } from '@/features/workflows/RunPanel';
import { WorkflowCanvas, type WorkflowCanvasHandle } from '@/features/workflows/WorkflowCanvas';
import { attachStudioEvents, useWorkflows } from '@/features/workflows/workflowsStore';

const READ_ONLY_REASON = 'Built-in templates are read-only. Duplicate it to edit.';

function NoProject() {
  const setView = useStudio((s) => s.setView);
  return (
    <EmptyState title="Choose a project" icon={<FolderGit2 size={22} />}>
      <p>Workflows and runs belong to a project. Select or create a project first.</p>
      <Button className="mt-3" variant="primary" onClick={() => setView('projects')}>Open Projects</Button>
    </EmptyState>
  );
}

function BuilderSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-4" aria-busy="true" aria-label="Loading workflow builder">
      <Skeleton className="h-7 w-64" /><Skeleton className="h-9 w-full" /><Skeleton className="h-72 w-full" />
    </div>
  );
}

function NoWorkflow() {
  const projectId = useWorkflows((s) => s.projectId);
  const hasTemplates = useWorkflows((s) => s.workflows.length > 0);
  const create = () => {
    const name = window.prompt('Name of the new workflow', 'New workflow')?.trim();
    if (name) void useWorkflows.getState().createWorkflow(name);
  };
  return (
    <EmptyState title={hasTemplates ? 'Choose a workflow' : 'No workflows yet'} icon={<WorkflowIcon size={22} />}>
      <p>{hasTemplates ? 'Pick a workflow in the list above, or start a new one.' : 'Start a new workflow, or import one from a JSON file.'}</p>
      <Button className="mt-3" variant="primary" disabled={!projectId} onClick={create}><Plus size={14} aria-hidden="true" /> New workflow</Button>
    </EmptyState>
  );
}

function ActionError() {
  const message = useWorkflows((s) => s.actionError);
  if (!message) return null;
  return (
    <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-st-failed/30 bg-st-failed/10 px-4 py-2 text-[13px] text-st-failed">
      <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={() => useWorkflows.getState().dismissActionError()} aria-label="Dismiss error"><X size={15} /></button>
    </div>
  );
}

/** Palette, canvas and inspector for the loaded workflow. */
function Editor({ canvasRef }: { canvasRef: RefObject<WorkflowCanvasHandle | null> }) {
  const editor = useWorkflows((s) => s.editor);
  const current = useWorkflows((s) => s.current);
  const catalog = useWorkflows((s) => s.catalog);
  const validation = useWorkflows((s) => s.validation);
  const timeline = useWorkflows((s) => s.timeline);
  const providers = useStudio((s) => s.providers);
  const [edgeId, setEdgeId] = useState<string | null>(null);

  const issues = useMemo(() => (validation ? [...validation.errors, ...validation.warnings] : undefined), [validation]);
  // Statuses belong to the workflow the run was started from; another workflow shows no run state.
  const nodeStatus = useMemo<Record<string, RunNodeStatus> | undefined>(
    () => (timeline && current && timeline.run.workflowId === current.id ? Object.fromEntries(timeline.nodes.map((node) => [node.nodeId, node])) : undefined),
    [timeline, current],
  );
  if (!editor || !current) return null;

  const readOnly = current.builtin;
  const onChange = useWorkflows.getState().edit;
  const add = (type: WorkflowNodeType) => {
    if (canvasRef.current) canvasRef.current.addNodeAtCenter(type);
    else useWorkflows.getState().addNodeOfType(type);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Node palette" className="hidden w-[220px] shrink-0 overflow-y-auto border-r border-line-soft md:block">
        <NodePalette catalog={catalog} onAdd={add} readOnlyReason={readOnly ? READ_ONLY_REASON : undefined} />
      </aside>
      <div className="min-w-0 flex-1" data-testid="canvas-area">
        <WorkflowCanvas ref={canvasRef} state={editor} catalog={catalog} nodeStatus={nodeStatus} issues={issues} readOnly={readOnly}
          selectedEdgeId={edgeId} onSelectEdge={setEdgeId} onChange={onChange} />
      </div>
      <aside aria-label="Inspector" className="w-[340px] shrink-0 overflow-y-auto border-l border-line-soft">
        <NodeInspector state={editor} catalog={catalog} providers={providers} issues={issues} readOnly={readOnly}
          selectedEdgeId={edgeId} onChange={onChange} />
      </aside>
    </div>
  );
}

function Body({ canvasRef }: { canvasRef: RefObject<WorkflowCanvasHandle | null> }) {
  const listStatus = useWorkflows((s) => s.listStatus);
  const listError = useWorkflows((s) => s.listError);
  const projectId = useWorkflows((s) => s.projectId);
  const current = useWorkflows((s) => s.current);
  const loading = useWorkflows((s) => s.loadingWorkflow);
  const workflowError = useWorkflows((s) => s.workflowError);
  const retry = () => { if (projectId) void useWorkflows.getState().open(projectId, hashParam(window.location.hash)); };

  if (listStatus === 'error') return <ErrorState title="Could not load workflows" message={listError ?? 'Unknown error'} onRetry={retry} />;
  if (listStatus !== 'ready') return <BuilderSkeleton />;
  if (current) return <Editor canvasRef={canvasRef} />;
  if (loading) return <BuilderSkeleton />;
  if (workflowError) return <ErrorState title="Could not load the workflow" message={workflowError} onRetry={retry} />;
  return <NoWorkflow />;
}

export function WorkflowBuilder() {
  const projectId = useStudio((s) => s.currentProjectId);
  const currentId = useWorkflows((s) => s.current?.id ?? null);
  const canvasRef = useRef<WorkflowCanvasHandle>(null);
  const [tab, setTab] = useState<RunPanelTab>('history');
  const [panelOpen, setPanelOpen] = useState(true);
  const showTab = (next: RunPanelTab) => { setTab(next); setPanelOpen(true); };

  useEffect(() => {
    const store = useWorkflows.getState();
    if (projectId) void store.open(projectId, hashParam(window.location.hash));
    else store.reset();
  }, [projectId]);

  useEffect(() => attachStudioEvents(), []);

  // #/builder/:workflowId follows the selected workflow, and back/forward or a pasted link selects it.
  useEffect(() => {
    if (currentId && viewFromHash(window.location.hash) === 'builder' && hashParam(window.location.hash) !== currentId) {
      window.history.replaceState(null, '', `#/builder/${encodeURIComponent(currentId)}`);
    }
  }, [currentId]);
  useEffect(() => {
    const onHash = () => {
      const id = hashParam(window.location.hash);
      if (id && viewFromHash(window.location.hash) === 'builder' && id !== useWorkflows.getState().current?.id) void useWorkflows.getState().selectWorkflow(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void useWorkflows.getState().save('manual');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!projectId) return <NoProject />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BuilderToolbar onShowTab={showTab} />
      <ActionError />
      <Body canvasRef={canvasRef} />
      <RunPanel tab={tab} onTabChange={setTab} open={panelOpen} onOpenChange={setPanelOpen} />
    </div>
  );
}
