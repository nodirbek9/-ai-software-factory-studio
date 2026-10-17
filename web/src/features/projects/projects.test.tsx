import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectSnapshot, RepoOverview, Run, RunsPage, Task, WorkflowSummary } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import ProjectDetail from '@/pages/ProjectDetail';
import Repos from '@/pages/Repos';
import { useStudio } from '@/store/studio';
import { eventFixture, projectFixture, taskFixture } from '@/test/sessionFixtures';
import * as api from './projectsApi';
import { RepoView } from './RepoView';

vi.mock('./projectsApi', () => ({
  getSnapshot: vi.fn(), pauseProject: vi.fn(), resumeProject: vi.fn(), cancelProject: vi.fn(), getReport: vi.fn(),
  getRepo: vi.fn(), listWorkflows: vi.fn(), startRun: vi.fn(), listRuns: vi.fn(),
}));
vi.mock('@/components/Markdown', async () => {
  const { createElement } = await import('react');
  return { Markdown: ({ children }: { children: string }) => createElement('div', { 'data-testid': 'markdown' }, children) };
});

const mocked = vi.mocked(api);

const runFixture = (overrides: Partial<Run> = {}): Run => ({
  id: 'run-1', projectId: 'project-1', number: 1, workflowId: 'wf-1', workflowName: 'Standard', workflowVersion: 1, status: 'completed',
  trigger: 'manual', baseCommit: null, startedAt: '2026-10-16T09:00:00Z', finishedAt: '2026-10-16T09:10:00Z', errorSummary: null,
  durationMs: 600000, costUsd: null, tasksTotal: 2, tasksCompleted: 2, ...overrides,
});

const workflowFixture = (overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: 'wf-1', projectId: null, name: 'Standard', description: '', version: 1, builtin: true, archived: false, nodeCount: 8,
  createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T09:00:00Z', ...overrides,
});

const repoFixture = (overrides: Partial<RepoOverview> = {}): RepoOverview => ({
  projectId: 'project-1', workspacePath: 'C:/work/atlas', integrationPath: 'C:/work/atlas-int', integrationBranch: 'asf/atlas/integration',
  integrationHead: 'abcdef1234567890', baseCommit: '1234567890abcdef',
  branches: [
    { name: 'asf/atlas/integration', kind: 'integration', head: 'abcdef1', ahead: null, behind: null, lastCommitAt: '2026-10-16T10:00:00Z', lastCommitSubject: 'Merge api', owner: null },
    { name: 'asf/atlas/task-api', kind: 'task', head: 'fedcba9', ahead: 3, behind: 1, lastCommitAt: '2026-10-16T10:05:00Z', lastCommitSubject: 'Add search route',
      owner: { type: 'task', id: 'task-a', title: 'Build the API', status: 'running' } },
  ],
  worktrees: [{ path: 'C:/work/atlas-wt/api', branch: 'asf/atlas/task-api', head: 'fedcba9', owner: { type: 'task', id: 'task-a', title: 'Build the API', status: 'running' }, modifiedAt: '2026-10-16T10:06:00Z' }],
  wipCommits: [{ branch: 'asf/atlas/task-api', sha: '0011223344', subject: 'wip(api): checkpoint', at: '2026-10-16T10:04:00Z' }],
  conflicts: [{ at: '2026-10-16T10:03:00Z', message: 'Conflict in src/app.ts', taskId: 'task-a' }],
  error: null, ...overrides,
});

function snapshotOf(overrides: Partial<ProjectSnapshot['project']> = {}, tasks: Task[] = []): ProjectSnapshot {
  return { project: projectFixture(overrides), tasks, agents: [], approvals: [], recentEvents: [] };
}

function setup({ project = {}, tasks = [], runs = [runFixture()], workflows = [workflowFixture()] }: {
  project?: Partial<ProjectSnapshot['project']>; tasks?: Task[]; runs?: Run[]; workflows?: WorkflowSummary[];
} = {}) {
  mocked.getSnapshot.mockResolvedValue(snapshotOf(project, tasks));
  mocked.listRuns.mockResolvedValue({ runs, nextBefore: null } satisfies RunsPage);
  mocked.listWorkflows.mockResolvedValue(workflows);
  mocked.getReport.mockResolvedValue(null);
}

async function openDetail() {
  render(<ProjectDetail projectId="project-1" />);
  await screen.findByRole('heading', { name: 'Atlas' });
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const tab = async (name: string) => { fireEvent.click(screen.getByRole('tab', { name })); };

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  useStudio.setState(useStudio.getInitialState(), true);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('ProjectDetail header', () => {
  it('shows the project facts and copies the workspace path', async () => {
    setup();
    await openDetail();
    expect(screen.getByText('C:/work/atlas')).toBeTruthy();
    expect(screen.getByText('asf/atlas/integration')).toBeTruthy();
    fireEvent.click(button('Copy workspace path'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/work/atlas'));
  });

  it('enables Pause and Cancel while running; Resume says why it is off', async () => {
    setup({ project: { status: 'running' } });
    await openDetail();
    expect(button('Pause').disabled).toBe(false);
    expect(button('Cancel').disabled).toBe(false);
    expect(button('Resume').disabled).toBe(true);
    expect(button('Resume').title).toBe('The project is not paused.');
  });

  it('enables Resume and Cancel while paused', async () => {
    setup({ project: { status: 'paused' } });
    await openDetail();
    expect(button('Resume').disabled).toBe(false);
    expect(button('Cancel').disabled).toBe(false);
    expect(button('Pause').disabled).toBe(true);
    expect(button('Pause').title).toMatch(/can be paused/);
  });

  it('disables every control for a completed project', async () => {
    setup({ project: { status: 'completed' } });
    await openDetail();
    for (const name of ['Pause', 'Resume', 'Cancel']) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).not.toBe('');
    }
  });

  it('pauses without a confirmation and reloads the project', async () => {
    setup({ project: { status: 'running' } });
    mocked.pauseProject.mockResolvedValue({});
    await openDetail();
    fireEvent.click(button('Pause'));
    await waitFor(() => expect(mocked.pauseProject).toHaveBeenCalledWith('project-1'));
    await waitFor(() => expect(mocked.getSnapshot).toHaveBeenCalledTimes(2));
  });

  it('cancels only after the confirmation', async () => {
    setup({ project: { status: 'running' } });
    mocked.cancelProject.mockResolvedValue({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await openDetail();
    fireEvent.click(button('Cancel'));
    expect(mocked.cancelProject).not.toHaveBeenCalled();
    fireEvent.click(button('Cancel'));
    await waitFor(() => expect(mocked.cancelProject).toHaveBeenCalledWith('project-1'));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows a failed action as an alert', async () => {
    setup({ project: { status: 'running' } });
    mocked.pauseProject.mockRejectedValue(new ApiError('Scheduler is busy', 409));
    await openDetail();
    fireEvent.click(button('Pause'));
    expect((await screen.findByRole('alert')).textContent).toBe('Scheduler is busy');
  });

  it('shows an error state with Retry when the project cannot be loaded', async () => {
    setup();
    mocked.getSnapshot.mockRejectedValueOnce(new ApiError('Project not found', 404));
    render(<ProjectDetail projectId="project-1" />);
    expect(await screen.findByText('Project not found')).toBeTruthy();
    fireEvent.click(button('Retry'));
    await screen.findByRole('heading', { name: 'Atlas' });
  });

  it('refreshes (throttled) when the stream reports a change of this project', async () => {
    setup();
    await openDetail();
    await waitFor(() => expect(mocked.listRuns).toHaveBeenCalledTimes(1));
    act(() => { useStudio.setState({ events: [eventFixture({ type: 'other.project', projectId: 'project-2' })] }); });
    act(() => { useStudio.setState({ events: [...useStudio.getState().events, eventFixture({ type: 'task.updated' }), eventFixture({ type: 'run.updated' })] }); });
    await waitFor(() => expect(mocked.getSnapshot).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(mocked.listRuns).toHaveBeenCalledTimes(2);
  });
});

describe('Start run menu', () => {
  it('is disabled with the reason while a run is active', async () => {
    setup({ runs: [runFixture({ id: 'run-2', number: 2, status: 'running' })] });
    await openDetail();
    await waitFor(() => expect(button(/Start run/).title).toMatch(/Run #2 is still running/));
    expect(button(/Start run/).disabled).toBe(true);
  });

  it('is disabled when there is no workflow', async () => {
    setup({ workflows: [] });
    await openDetail();
    await waitFor(() => expect(button(/Start run/).title).toMatch(/No workflows available/));
  });

  it('lists project and global workflows and starts the chosen one', async () => {
    setup({ workflows: [workflowFixture(), workflowFixture({ id: 'wf-p', projectId: 'project-1', name: 'Hotfix flow', builtin: false })] });
    mocked.startRun.mockResolvedValue(runFixture({ id: 'run-3', number: 3, status: 'running' }));
    await openDetail();
    await waitFor(() => expect(button(/Start run/).disabled).toBe(false));
    fireEvent.click(button(/Start run/));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('group', { name: 'Project workflows' })).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Global templates' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Hotfix flow/ }));
    await waitFor(() => expect(mocked.startRun).toHaveBeenCalledWith('project-1', 'wf-p'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ProjectDetail tabs', () => {
  it('Overview derives progress from the active run task states', async () => {
    const tasks = [
      taskFixture({ id: 't1', key: 'plan', runId: 'run-1', status: 'completed' }),
      taskFixture({ id: 't2', key: 'api', runId: 'run-1', status: 'failed', error: 'Tests failed' }),
      taskFixture({ id: 't3', key: 'old', runId: 'run-0', status: 'completed' }),
    ];
    setup({ project: { spec: 'Build a search API' }, tasks, runs: [runFixture({ status: 'running', errorSummary: null })] });
    await openDetail();
    expect(await screen.findByText('1 / 2 tasks completed')).toBeTruthy();
    expect(screen.getByText('Build a search API')).toBeTruthy();
    expect(screen.getByText('Tests failed')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('Overview says when there are no tasks or errors yet', async () => {
    setup({ runs: [] });
    await openDetail();
    expect(await screen.findByText(/No tasks yet/)).toBeTruthy();
    expect(screen.getByText('No task errors.')).toBeTruthy();
    expect(screen.getByText('This project has no saved specification.')).toBeTruthy();
  });

  it('Requirements and Architecture render Markdown or an empty state', async () => {
    setup({ project: { spec: '# Spec', planMarkdown: null } });
    await openDetail();
    await tab('Requirements');
    expect(screen.getByTestId('markdown').textContent).toBe('# Spec');
    await tab('Architecture');
    expect(screen.queryByTestId('markdown')).toBeNull();
    expect(screen.getByText('Generated by the Architect step.')).toBeTruthy();
  });

  it('Plan lists the run tasks in order with the no-grouping note', async () => {
    const tasks = [
      taskFixture({ id: 't2', key: 'api', title: 'Build API', runId: 'run-1', orderIndex: 2, dependsOn: ['plan'] }),
      taskFixture({ id: 't1', key: 'plan', title: 'Write plan', runId: 'run-1', orderIndex: 1 }),
    ];
    setup({ tasks });
    await openDetail();
    await tab('Plan');
    const items = within(screen.getByRole('list', { name: 'Plan' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining('Write plan'), expect.stringContaining('Build API')]);
    expect(screen.getByText(/not grouped/)).toBeTruthy();
  });

  it('Plan shows an empty state without tasks', async () => {
    setup();
    await openDetail();
    await tab('Plan');
    expect(screen.getByText('No plan yet')).toBeTruthy();
  });

  it('Runs lists runs and loads the next page', async () => {
    setup({ runs: [runFixture({ id: 'run-2', number: 2, status: 'failed', errorSummary: 'Gate failed' })] });
    mocked.listRuns.mockResolvedValueOnce({ runs: [runFixture({ id: 'run-2', number: 2, status: 'failed', errorSummary: 'Gate failed' })], nextBefore: 2 });
    mocked.listRuns.mockResolvedValueOnce({ runs: [runFixture({ id: 'run-1', number: 1 })], nextBefore: null });
    await openDetail();
    await tab('Runs');
    expect(await screen.findByText('Gate failed')).toBeTruthy();
    fireEvent.click(button('Load more'));
    await waitFor(() => expect(mocked.listRuns).toHaveBeenLastCalledWith('project-1', 2));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Runs' })).getAllByRole('row')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('Runs shows an empty state', async () => {
    setup({ runs: [] });
    await openDetail();
    await tab('Runs');
    expect(await screen.findByText('No runs yet')).toBeTruthy();
  });

  it('Tasks links to the Tasks page', async () => {
    setup({ tasks: [taskFixture({ runId: 'run-1' })] });
    await openDetail();
    await tab('Tasks');
    expect(screen.getByRole('link', { name: /Open Tasks board/ }).getAttribute('href')).toBe('#/tasks');
  });

  it('Report renders Markdown, or an empty state on 404', async () => {
    setup();
    mocked.getReport.mockResolvedValueOnce('# Delivered');
    await openDetail();
    await tab('Report');
    expect((await screen.findByTestId('markdown')).textContent).toBe('# Delivered');
  });

  it('Report empty state when the server has no report', async () => {
    setup();
    await openDetail();
    await tab('Report');
    expect(await screen.findByText('No delivery report yet')).toBeTruthy();
  });

  it('Report error state offers Retry', async () => {
    setup();
    mocked.getReport.mockRejectedValueOnce(new ApiError('boom', 500)).mockResolvedValueOnce('ok');
    await openDetail();
    await tab('Report');
    expect(await screen.findByText('boom')).toBeTruthy();
    fireEvent.click(button('Retry'));
    expect((await screen.findByTestId('markdown')).textContent).toBe('ok');
  });

  it('Settings is read-only', async () => {
    setup({ project: { testCommand: 'npm run check' } });
    await openDetail();
    await tab('Settings');
    expect(screen.getByText('npm run check')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('RepoView', () => {
  it('renders summary, branches, worktrees, wip commits and conflicts', async () => {
    mocked.getRepo.mockResolvedValue(repoFixture());
    render(<RepoView projectId="project-1" />);
    expect(await screen.findByText('abcdef1')).toBeTruthy();
    expect(screen.getByText('1234567')).toBeTruthy();

    const branches = within(screen.getByRole('table', { name: 'Branches' }));
    expect(branches.getAllByRole('row')).toHaveLength(3);
    expect(branches.getByText('↑3 ↓1')).toBeTruthy();
    expect(branches.getByText('Integration')).toBeTruthy();
    expect(branches.getByText('Add search route')).toBeTruthy();
    expect(branches.getByRole('link', { name: /Build the API/ })).toBeTruthy();

    expect(within(screen.getByRole('table', { name: 'Worktrees' })).getByText('C:/work/atlas-wt/api')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Wip commits' })).getByText('wip(api): checkpoint')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Conflicts seen' })).getByText('Conflict in src/app.ts')).toBeTruthy();
  });

  it('has no write actions', async () => {
    mocked.getRepo.mockResolvedValue(repoFixture());
    render(<RepoView projectId="project-1" />);
    await screen.findByRole('table', { name: 'Branches' });
    const names = screen.getAllByRole('button').map((item) => item.getAttribute('aria-label') ?? item.textContent ?? '');
    expect(names.filter((name) => /delete|push|checkout|remove/i.test(name))).toEqual([]);
  });

  it('shows empty sections', async () => {
    mocked.getRepo.mockResolvedValue(repoFixture({ branches: [], worktrees: [], wipCommits: [], conflicts: [] }));
    render(<RepoView projectId="project-1" />);
    expect(await screen.findByText('No leftover wip commits.')).toBeTruthy();
    expect(screen.getByText('No merge conflicts recorded.')).toBeTruthy();
    expect(screen.getByText('No worktrees.')).toBeTruthy();
  });

  it('shows the RepoOverview error from the server', async () => {
    mocked.getRepo.mockResolvedValue(repoFixture({ error: 'Not a git repository', branches: [], worktrees: [], wipCommits: [], conflicts: [] }));
    render(<RepoView projectId="project-1" />);
    expect((await screen.findByText('Not a git repository'))).toBeTruthy();
    expect(screen.getByText('Nothing to show')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Branches' })).toBeNull();
  });

  it('shows a request failure with Retry and refreshes on demand', async () => {
    mocked.getRepo.mockRejectedValueOnce(new ApiError('Server down', 500)).mockResolvedValue(repoFixture());
    render(<RepoView projectId="project-1" />);
    expect(await screen.findByText('Server down')).toBeTruthy();
    fireEvent.click(button('Retry'));
    await screen.findByRole('table', { name: 'Branches' });
    fireEvent.click(button('Refresh'));
    await waitFor(() => expect(mocked.getRepo).toHaveBeenCalledTimes(3));
  });

  it('copy buttons write the full value to the clipboard', async () => {
    mocked.getRepo.mockResolvedValue(repoFixture());
    render(<RepoView projectId="project-1" />);
    await screen.findByRole('table', { name: 'Branches' });
    fireEvent.click(button('Copy integration head'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('abcdef1234567890'));
    fireEvent.click(button('Copy workspace path'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/work/atlas'));
    expect(button('Copy integration head').title).not.toBe('');
  });

  it('disables copy with a reason when the clipboard is unavailable', async () => {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    mocked.getRepo.mockResolvedValue(repoFixture());
    render(<RepoView projectId="project-1" />);
    await screen.findByRole('table', { name: 'Branches' });
    expect(button('Copy workspace path').disabled).toBe(true);
    expect(button('Copy workspace path').title).toMatch(/not available/);
  });
});

describe('Repos page', () => {
  it('defaults to the header project and switches with the picker', async () => {
    const atlas = projectFixture();
    const other = projectFixture({ id: 'project-2', name: 'Borealis' });
    useStudio.setState({ projects: [atlas, other], currentProjectId: 'project-1' });
    mocked.getRepo.mockResolvedValue(repoFixture());
    render(<Repos />);
    await screen.findByRole('table', { name: 'Branches' });
    expect(mocked.getRepo).toHaveBeenLastCalledWith('project-1');
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'project-2' } });
    await waitFor(() => expect(mocked.getRepo).toHaveBeenLastCalledWith('project-2'));
  });

  it('shows an empty state without projects', () => {
    render(<Repos />);
    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(mocked.getRepo).not.toHaveBeenCalled();
  });
});
