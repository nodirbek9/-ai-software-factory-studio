import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Run, TaskDetail, TaskDiff, TaskRow } from '@asf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Tasks, { buildTaskQuery } from '@/pages/Tasks';
import { useStudio } from '@/store/studio';
import { eventFixture, projectFixture, taskFixture } from '@/test/sessionFixtures';
import { diffLineKind } from './TaskDrawer';
import { sortTasks } from './TaskList';
import * as api from './tasksApi';
import * as workflowsApi from '@/features/workflows/workflowsApi';

vi.mock('./tasksApi');
vi.mock('@/features/workflows/workflowsApi');

const mocked = vi.mocked(api);
const mockedRuns = vi.mocked(workflowsApi);

function row(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return { ...taskFixture({ id, key: `key-${id}`, title: `Task ${id}` }), projectName: 'Atlas', runNumber: 1, durationMs: 60_000, ...overrides };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', projectId: 'project-1', number: 1, workflowId: 'wf', workflowName: 'Standard', workflowVersion: 1, status: 'running', trigger: 'manual',
    baseCommit: null, startedAt: '2026-10-16T10:00:00Z', finishedAt: null, errorSummary: null, durationMs: null, costUsd: null, tasksTotal: 3, tasksCompleted: 1, ...overrides,
  };
}

function detailOf(task: TaskRow, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { task, run: null, events: [], fixRounds: null, reviewText: null, ...overrides };
}

const DIFF: TaskDiff = {
  taskId: 'f', base: 'abc1234567890', head: 'def7654321000', files: ['src/a.ts'], truncated: true, note: 'omitted 1 sensitive file',
  diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged',
};

const ROWS: TaskRow[] = [
  row('p1', { status: 'pending', title: 'Pending one' }),
  row('p2', { status: 'pending', title: 'Pending two' }),
  row('r1', { status: 'running', role: 'backend', attempt: 2, maxAttempts: 3, providerId: 'codex', title: 'Running one' }),
  row('f', { status: 'failed', role: 'qa', title: 'Failed one', error: 'tests exited 1' }),
  row('c1', { status: 'completed', title: 'Done one' }),
  row('x', { status: 'cancelled', title: 'Cancelled one' }),
];

function setup(rows: TaskRow[] = ROWS, runs: Run[] = [run(), run({ id: 'run-2', number: 2 })]) {
  mocked.listTasks.mockResolvedValue({ tasks: rows, truncated: false });
  mocked.getTaskDetail.mockImplementation(async (id) => detailOf(rows.find((r) => r.id === id) ?? rows[0]));
  mocked.getTaskDiff.mockResolvedValue(DIFF);
  mocked.retryTask.mockResolvedValue(undefined);
  mocked.cancelTask.mockResolvedValue(undefined);
  mockedRuns.listRuns.mockResolvedValue({ runs, nextBefore: null });
}

async function openPage(rows?: TaskRow[]) {
  setup(rows);
  render(<Tasks />);
  await waitFor(() => expect(mocked.listTasks).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByLabelText('Loading tasks')).toBeNull());
}

const column = (name: string) => screen.getByRole('region', { name });
const lastQuery = () => mocked.listTasks.mock.lastCall?.[0];

async function openDrawer(id: string) {
  const card = await waitFor(() => {
    const found = document.querySelector(`[data-task="${id}"]`);
    expect(found).toBeTruthy();
    return found;
  });
  fireEvent.click(card as Element);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('region', { name: 'Description' });
}

beforeEach(() => {
  vi.resetAllMocks();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ currentProjectId: 'project-1', projects: [projectFixture(), projectFixture({ id: 'project-2', name: 'Borealis' })] });
});

describe('Tasks board', () => {
  it('shows every column with its count and hides cancelled until toggled', async () => {
    await openPage();
    const names = ['Pending', 'Ready', 'Running', 'Waiting approval', 'Blocked', 'Failed', 'Completed'];
    expect(names.map((name) => column(name).getAttribute('aria-label'))).toEqual(names);
    expect(within(column('Pending')).getByLabelText('2 tasks')).toBeTruthy();
    expect(within(column('Running')).getByLabelText('1 tasks')).toBeTruthy();
    expect(within(column('Ready')).getByLabelText('0 tasks')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Cancelled' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Show cancelled'));
    expect(within(column('Cancelled')).getByLabelText('1 tasks')).toBeTruthy();
  });

  it('renders cards with key, attempts and provider as focusable buttons', async () => {
    await openPage();
    const card = within(column('Running')).getByText('Running one').closest('button') as HTMLElement;
    expect(card.dataset.task).toBe('r1');
    expect(card.textContent).toContain('key-r1');
    expect(card.textContent).toContain('Attempt 2/3');
    expect(card.textContent).toContain('codex');
    expect(card.textContent).not.toContain('Atlas');
  });

  it('computes progress from task states only', async () => {
    await openPage();
    const strip = screen.getByRole('list', { name: 'Progress per project' });
    expect(within(strip).getByText('1 / 5')).toBeTruthy();
    expect(within(strip).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');
  });

  it('shows the empty state and the filtered empty state', async () => {
    await openPage([]);
    expect(screen.getByText('No tasks yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'qa' } });
    expect(await screen.findByText('No tasks match these filters')).toBeTruthy();
  });

  it('shows an error state with Retry', async () => {
    setup();
    mocked.listTasks.mockRejectedValueOnce(new Error('boom'));
    render(<Tasks />);
    expect(await screen.findByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Pending' })).toBeTruthy();
  });

  it('links to the V1 task graph', async () => {
    await openPage();
    expect(screen.getByRole('link', { name: /Open task graph/ }).getAttribute('href')).toBe('#/board');
  });
});

describe('Tasks filters', () => {
  it('defaults to the header project with the active run', async () => {
    await openPage();
    expect(lastQuery()).toEqual({ projectId: 'project-1' });
  });

  it('sends role, status and run filters', async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'backend' } });
    await waitFor(() => expect(lastQuery()).toEqual({ projectId: 'project-1', role: 'backend' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => expect(lastQuery()).toEqual({ projectId: 'project-1', role: 'backend', status: 'failed' }));
    await screen.findByRole('option', { name: 'Run #2' });
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'run-2' } });
    await waitFor(() => expect(lastQuery()).toEqual({ projectId: 'project-1', role: 'backend', status: 'failed', runId: 'run-2' }));
    fireEvent.change(screen.getByLabelText('Run'), { target: { value: 'all' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ runId: 'all' }));
  });

  it('debounces the search box', async () => {
    await openPage();
    const calls = mocked.listTasks.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'login' } });
    expect(mocked.listTasks.mock.calls.length).toBe(calls);
    await waitFor(() => expect(lastQuery()).toEqual({ projectId: 'project-1', q: 'login' }));
  });

  it('switches to all projects and shows the project name on cards', async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    await waitFor(() => expect(lastQuery()).toEqual({}));
    await waitFor(() => expect(within(column('Pending')).getAllByText('Atlas').length).toBe(2));
  });

  it('builds a query with only the set filters', () => {
    expect(buildTaskQuery({ project: '', run: 'active', role: '', status: '' }, '  ')).toEqual({});
    expect(buildTaskQuery({ project: 'p', run: 'all', role: 'qa', status: 'failed' }, ' x ')).toEqual({ projectId: 'p', runId: 'all', role: 'qa', status: 'failed', q: 'x' });
  });

  it('re-fetches on task events of its project only', async () => {
    await openPage();
    expect(mocked.listTasks).toHaveBeenCalledTimes(1);
    act(() => { useStudio.setState({ events: [eventFixture({ type: 'task.updated', projectId: 'project-2' })] }); });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocked.listTasks).toHaveBeenCalledTimes(1);
    act(() => { useStudio.setState({ events: [...useStudio.getState().events, eventFixture({ type: 'task.updated', projectId: 'project-1' })] }); });
    await waitFor(() => expect(mocked.listTasks).toHaveBeenCalledTimes(2));
  });
});

describe('Tasks list', () => {
  const titles = (container: HTMLElement) => [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td:nth-child(2) span')?.textContent);

  it('sorts by a column and toggles the direction', async () => {
    const rows = [row('1', { title: 'Bravo' }), row('2', { title: 'Alpha' }), row('3', { title: 'Charlie' })];
    setup(rows);
    const { container } = render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(titles(container)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    expect(titles(container)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(screen.getByRole('columnheader', { name: 'Title' }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    expect(titles(container)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts durations numerically with unstarted tasks last', () => {
    const rows = [row('a', { durationMs: 90_000 }), row('b', { durationMs: null }), row('c', { durationMs: 5_000 })];
    expect(sortTasks(rows, 'duration', 'asc').map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortTasks(rows, 'duration', 'desc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('opens the drawer from a row', async () => {
    setup();
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    fireEvent.click(document.querySelector('tr[data-task="f"]') as Element);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(mocked.getTaskDetail).toHaveBeenCalledWith('f');
  });
});

describe('Task drawer', () => {
  it('shows every section', async () => {
    const failed = row('f', {
      status: 'failed', role: 'qa', title: 'Failed one', description: 'Run the suite', resultSummary: 'Suite failed', error: 'tests exited 1',
      filesChanged: ['src/a.ts'], usage: { inputTokens: 1200, outputTokens: 300, costUsd: null },
      testResult: { command: 'npm test', exitCode: 1, passed: false, durationMs: 4000, outputTail: 'FAIL src/a.test.ts', summary: '1 failed' },
    });
    setup([failed]);
    mocked.getTaskDetail.mockResolvedValue(detailOf(failed, {
      reviewText: 'Looks risky', fixRounds: { used: 1, max: 3 },
      events: [eventFixture({ type: 'task.failed', level: 'error', message: 'agent crashed', createdAt: '2026-10-16T10:04:05Z' })],
    }));
    render(<Tasks />);
    await openDrawer('f');
    const dialog = within(screen.getByRole('dialog'));
    for (const name of ['Description', 'Result summary', 'Test result', 'Review text', 'Files changed', 'Git diff', 'Usage', 'Fix rounds', 'Events']) {
      expect(dialog.getByRole('region', { name })).toBeTruthy();
    }
    expect(dialog.getByText('Run the suite')).toBeTruthy();
    expect(dialog.getByText('Suite failed')).toBeTruthy();
    expect(dialog.getByText('tests exited 1')).toBeTruthy();
    expect(dialog.getByText('npm test')).toBeTruthy();
    expect(dialog.getByText('FAIL src/a.test.ts').tagName).toBe('PRE');
    expect(dialog.getByText('Looks risky')).toBeTruthy();
    expect(dialog.getByText('src/a.ts')).toBeTruthy();
    expect(dialog.getByText('1.2k')).toBeTruthy();
    expect(dialog.getByText('not reported')).toBeTruthy();
    expect(dialog.getByText('1 / 3 used')).toBeTruthy();
    expect(dialog.getByText('agent crashed')).toBeTruthy();
    expect(dialog.getByText('· run #1')).toBeTruthy();
  });

  it('offers Retry only for failed or cancelled tasks and Cancel only for unfinished ones', async () => {
    const expectButtons = async (id: string, retry: boolean, cancel: boolean) => {
      await openDrawer(id);
      expect(!!screen.queryByRole('button', { name: 'Retry' })).toBe(retry);
      expect(!!screen.queryByRole('button', { name: 'Cancel task' })).toBe(cancel);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    setup();
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await expectButtons('f', true, false);
    await expectButtons('r1', false, true);
    await expectButtons('c1', false, false);
    fireEvent.click(screen.getByLabelText('Show cancelled'));
    await expectButtons('x', true, false);
  });

  it('confirms before retrying and re-fetches the board', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup();
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await openDrawer('f');
    const before = mocked.listTasks.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocked.retryTask).toHaveBeenCalledWith('f'));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(mocked.listTasks.mock.calls.length).toBeGreaterThan(before));
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    setup();
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await openDrawer('r1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(mocked.cancelTask).not.toHaveBeenCalled();
  });

  it('shows the error when an action fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup();
    mocked.cancelTask.mockRejectedValue(new Error('task already finished'));
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await openDrawer('r1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(await screen.findByText('Cancel failed: task already finished')).toBeTruthy();
  });

  it('loads the git diff lazily when its section is opened', async () => {
    setup();
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await openDrawer('f');
    expect(mocked.getTaskDiff).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Git diff' }));
    await waitFor(() => expect(mocked.getTaskDiff).toHaveBeenCalledWith('f'));
    await waitFor(() => expect(document.querySelectorAll('[data-diff="add"]').length).toBe(1));
    expect(document.querySelector('[data-diff="add"]')?.textContent).toBe('+new line');
    expect(document.querySelector('[data-diff="del"]')?.textContent).toBe('-old line');
    expect(document.querySelector('pre [data-diff="hunk"]')?.textContent).toContain('@@');
    expect(screen.getByText('The diff was truncated (300 KB limit).')).toBeTruthy();
    expect(screen.getByText('omitted 1 sensitive file')).toBeTruthy();
  });

  it('shows an error with Retry when the diff cannot be loaded', async () => {
    setup();
    mocked.getTaskDiff.mockRejectedValueOnce(new Error('git unavailable'));
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    await openDrawer('r1');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Git diff' }));
    expect(await screen.findByText('git unavailable')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(document.querySelectorAll('[data-diff="add"]').length).toBe(1));
  });

  it('shows an error when the task detail cannot be loaded', async () => {
    setup();
    mocked.getTaskDetail.mockRejectedValue(new Error('detail down'));
    render(<Tasks />);
    await screen.findByRole('region', { name: 'Pending' });
    fireEvent.click(document.querySelector('[data-task="f"]') as Element);
    expect(await screen.findByText('detail down')).toBeTruthy();
  });

  it('classifies unified diff lines', () => {
    expect(['diff --git a b', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '+add', '-del', ' ctx'].map(diffLineKind))
      .toEqual(['meta', 'meta', 'meta', 'hunk', 'add', 'del', 'context']);
  });
});
