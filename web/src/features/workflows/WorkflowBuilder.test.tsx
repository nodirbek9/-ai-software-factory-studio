import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Run, RunsPage, ValidationResult, Workflow, WorkflowGraph } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowBuilder } from '@/pages/WorkflowBuilder';
import { useStudio } from '@/store/studio';
import { projectFixture, taskFixture, eventFixture } from '@/test/sessionFixtures';
import { BUILTIN_BANNER } from './BuilderToolbar';
import * as api from './workflowsApi';
import { handleStudioEvent, runBlockReason, useWorkflows } from './workflowsStore';

vi.mock('./workflowsApi');
// The canvas, palette and inspector belong to p4-canvas and have their own tests; here they are stubs.
vi.mock('./WorkflowCanvas', () => ({ WorkflowCanvas: () => <div data-testid="canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <div data-testid="palette" /> }));
vi.mock('./NodeInspector', () => ({ NodeInspector: () => <div data-testid="inspector" /> }));

const mocked = vi.mocked(api);

const GRAPH: WorkflowGraph = {
  schemaVersion: 1,
  nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
};

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-standard', projectId: null, name: 'Standard Software Factory', description: '', version: 1, builtin: true, archived: false,
    nodeCount: 1, createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z', graph: GRAPH, ...overrides,
  };
}

const custom = (overrides: Partial<Workflow> = {}): Workflow =>
  workflow({ id: 'wf-custom', projectId: 'project-1', name: 'My flow', builtin: false, ...overrides });

function summary(item: Workflow) {
  const { graph, ...rest } = item;
  return { ...rest, nodeCount: graph.nodes.length };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', projectId: 'project-1', number: 1, workflowId: 'wf-standard', workflowName: 'Standard Software Factory', workflowVersion: 1,
    status: 'completed', trigger: 'manual', baseCommit: null, startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T10:05:00Z',
    errorSummary: null, durationMs: 300_000, costUsd: null, tasksTotal: 10, tasksCompleted: 10, ...overrides,
  };
}

const VALID: ValidationResult = { ok: true, errors: [], warnings: [] };

interface Setup {
  workflows?: Workflow[];
  runs?: Run[];
  validation?: ValidationResult;
}

function mockApi({ workflows = [workflow()], runs = [], validation = VALID }: Setup = {}) {
  mocked.getCatalog.mockResolvedValue([]);
  mocked.listWorkflows.mockResolvedValue(workflows.map(summary));
  mocked.getWorkflow.mockImplementation(async (id) => workflows.find((item) => item.id === id) ?? workflows[0]);
  mocked.validateWorkflow.mockResolvedValue(validation);
  mocked.listRuns.mockResolvedValue({ runs, nextBefore: null } satisfies RunsPage);
  mocked.getRunTimeline.mockImplementation(async (runId) => ({
    run: runs.find((item) => item.id === runId) ?? runs[0], graph: GRAPH, nodes: [], tasks: [], entries: [],
  }));
  mocked.archiveWorkflow.mockResolvedValue(undefined);
}

async function openBuilder(setup: Setup = {}) {
  mockApi(setup);
  render(<WorkflowBuilder />);
  await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy());
  await waitFor(() => expect(useWorkflows.getState().validating).toBe(false));
}

const runButton = () => screen.getByRole('button', { name: /^Run$/ }) as HTMLButtonElement;

beforeEach(() => {
  vi.resetAllMocks();
  useWorkflows.getState().reset();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ currentProjectId: 'project-1', projects: [projectFixture()], providers: [] });
  window.location.hash = '#/builder';
});

afterEach(() => {
  useWorkflows.getState().reset();
  vi.restoreAllMocks();
});

describe('WorkflowBuilder page', () => {
  it('asks for a project when none is selected', () => {
    useStudio.setState({ currentProjectId: null });
    render(<WorkflowBuilder />);
    expect(screen.getByText('Choose a project')).toBeTruthy();
    expect(mocked.listWorkflows).not.toHaveBeenCalled();
  });

  it('shows the built-in template read-only with the Duplicate banner', async () => {
    await openBuilder();
    expect(screen.getByText(BUILTIN_BANNER)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets only the templates through when the project has no workflows of its own', async () => {
    await openBuilder();
    const select = screen.getByRole('combobox', { name: 'Workflow' }) as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Standard Software Factory (built-in)']);
  });

  it('shows the empty state when nothing can be listed', async () => {
    mockApi({ workflows: [] });
    render(<WorkflowBuilder />);
    expect(await screen.findByText('No workflows yet')).toBeTruthy();
  });

  it('shows an error state with Retry when the list fails to load', async () => {
    mockApi();
    mocked.listWorkflows.mockRejectedValue(new Error('boom'));
    render(<WorkflowBuilder />);
    expect(await screen.findByText('Could not load workflows')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });
});

describe('Run button', () => {
  it('is enabled for a valid saved workflow and explains every disabled state', async () => {
    await openBuilder({ workflows: [workflow(), custom()] });
    await waitFor(() => expect(runButton().disabled).toBe(false));

    const base = useWorkflows.getState();
    expect(runBlockReason({ ...base, projectId: null })).toMatch(/Select a project/);
    expect(runBlockReason({ ...base, validation: null })).toMatch(/Validate the workflow first/);
    expect(runBlockReason({ ...base, validation: { ok: false, errors: [{ code: 'E_TRIGGER', severity: 'error', message: 'x' }], warnings: [] } }))
      .toMatch(/1 validation error/);
    expect(runBlockReason({ ...base, runs: [run({ status: 'running', number: 4 })] })).toMatch(/Run #4 is still running/);
    expect(runBlockReason({ ...base, current: custom(), editor: { ...base.editor!, dirty: true } })).toMatch(/Unsaved changes/);
  });

  it('is disabled with the reason as tooltip while the project has an active run', async () => {
    await openBuilder({ runs: [run({ status: 'running', number: 3, finishedAt: null, durationMs: null })] });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(runButton().closest('span')?.getAttribute('title')).toMatch(/Run #3 is still running/);
  });

  it('is disabled while the workflow has validation errors', async () => {
    const validation: ValidationResult = {
      ok: false, errors: [{ code: 'E_TRIGGER', severity: 'error', message: 'The workflow needs exactly one trigger.' }], warnings: [],
    };
    await openBuilder({ validation });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(runButton().closest('span')?.getAttribute('title')).toMatch(/1 validation error/);
  });
});

describe('Run panel', () => {
  it('shows validation issues and focuses the node of a clicked issue', async () => {
    const validation: ValidationResult = {
      ok: false,
      errors: [{ code: 'E_CONFIG', severity: 'error', message: 'Backend needs a prompt.', nodeId: 'trigger' }],
      warnings: [{ code: 'E_PROVIDER', severity: 'warning', message: 'Provider is offline.' }],
    };
    await openBuilder({ validation });
    fireEvent.click(screen.getByRole('button', { name: /^Validate$/ }));
    expect(await screen.findByText('Backend needs a prompt.')).toBeTruthy();
    expect(screen.getByText('Provider is offline.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Validation (2)' })).toBeTruthy();

    fireEvent.click(screen.getByText('Backend needs a prompt.'));
    expect(useWorkflows.getState().editor?.selection).toEqual(['trigger']);
  });

  it('renders the run history with status, trigger, duration and "not reported" cost', async () => {
    await openBuilder({
      runs: [
        run({ id: 'run-2', number: 2, status: 'failed', errorSummary: 'Tests failed after 2 rounds', costUsd: 0.42 }),
        run({ id: 'run-1', number: 1 }),
      ],
    });
    const history = await screen.findByRole('table');
    expect(within(history).getByText('#2')).toBeTruthy();
    expect(within(history).getByText('Failed')).toBeTruthy();
    expect(within(history).getByText('Completed')).toBeTruthy();
    expect(within(history).getByText('Tests failed after 2 rounds')).toBeTruthy();
    expect(within(history).getByText('$0.42')).toBeTruthy();
    expect(within(history).getByText('not reported')).toBeTruthy();
    expect(within(history).getAllByText('manual')).toHaveLength(2);
    expect(within(history).getAllByText('5m 0s')).toHaveLength(2);
  });

  it('offers Cancel run for the active run and asks to confirm', async () => {
    mocked.cancelRun.mockResolvedValue({});
    await openBuilder({ runs: [run({ status: 'running', finishedAt: null, durationMs: null })] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel run/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocked.cancelRun).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }));
    await waitFor(() => expect(mocked.cancelRun).toHaveBeenCalledWith('run-1'));
  });

  it('collapses and expands', async () => {
    await openBuilder();
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse run panel' }));
    expect(screen.queryByRole('tabpanel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand run panel' }));
    expect(screen.getByRole('tabpanel')).toBeTruthy();
  });
});

describe('toolbar actions', () => {
  it('asks for confirmation before archiving and archives only after "yes"', async () => {
    await openBuilder({ workflows: [workflow(), custom()] });
    await waitFor(() => expect(useWorkflows.getState().current?.id).toBe('wf-custom'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocked.archiveWorkflow).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(mocked.archiveWorkflow).toHaveBeenCalledWith('wf-custom'));
  });

  it('duplicates the built-in template and opens the copy for editing', async () => {
    const copy = custom({ id: 'wf-copy', name: 'Standard Software Factory (copy)' });
    await openBuilder({ workflows: [workflow(), copy] });
    mocked.duplicateWorkflow.mockResolvedValue(copy);
    await act(async () => { await useWorkflows.getState().selectWorkflow('wf-standard'); });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate this template' }));
    await waitFor(() => expect(useWorkflows.getState().current?.id).toBe('wf-copy'));
    expect(screen.queryByText(BUILTIN_BANNER)).toBeNull();
  });

  it('saves with Ctrl+S and reports "Saved hh:mm"', async () => {
    await openBuilder({ workflows: [custom()] });
    mocked.saveWorkflow.mockResolvedValue(custom({ version: 2 }));
    act(() => {
      const editor = useWorkflows.getState().editor!;
      useWorkflows.getState().edit({ ...editor, graph: { ...editor.graph, nodes: [{ ...editor.graph.nodes[0], label: 'Start' }] }, dirty: true });
    });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mocked.saveWorkflow).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/^Saved \d\d:\d\d$/)).toBeTruthy();
  });
});

describe('live events', () => {
  it('refreshes the runs on run.updated and the timeline (throttled) on a task of the selected run', async () => {
    await openBuilder({ runs: [run()] });
    await waitFor(() => expect(useWorkflows.getState().selectedRunId).toBe('run-1'));
    mocked.listRuns.mockClear();

    handleStudioEvent(eventFixture({ type: 'run.updated', data: { run: run({ status: 'running' }) } }));
    await waitFor(() => expect(mocked.listRuns).toHaveBeenCalled(), { timeout: 3000 });

    // The run.updated above also scheduled a timeline refresh; let it settle, then start counting.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    mocked.getRunTimeline.mockClear();
    handleStudioEvent(eventFixture({ type: 'task.updated', data: { task: taskFixture({ runId: 'other-run' }) } }));
    handleStudioEvent(eventFixture({ type: 'task.updated', data: { task: taskFixture({ runId: 'run-1' }) } }));
    handleStudioEvent(eventFixture({ type: 'task.updated', data: { task: taskFixture({ runId: 'run-1' }) } }));
    await waitFor(() => expect(mocked.getRunTimeline).toHaveBeenCalledWith('run-1'), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mocked.getRunTimeline).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('ignores events of another project', async () => {
    await openBuilder({ runs: [run()] });
    mocked.listRuns.mockClear();
    handleStudioEvent(eventFixture({ type: 'run.updated', projectId: 'project-2', data: { run: run() } }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mocked.listRuns).not.toHaveBeenCalled();
  });
});
