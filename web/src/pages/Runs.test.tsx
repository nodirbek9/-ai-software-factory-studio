import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Run, RunTimeline } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { hashParam, useStudio, viewFromHash } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { liveSnapshot } from '@/test/fixtures';
import { eventFixture, projectFixture, taskFixture } from '@/test/sessionFixtures';
import Runs from './Runs';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1', projectId: 'project-1', number: 1, workflowId: 'wf-1', workflowName: 'Build API', workflowVersion: 2,
    status: 'failed', trigger: 'manual', baseCommit: null, startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T10:01:00Z',
    errorSummary: 'Tests failed', durationMs: 60000, costUsd: null, tasksTotal: 2, tasksCompleted: 1, ...overrides,
  };
}

function timeline(overrides: Partial<Run> = {}): RunTimeline {
  return {
    run: run(overrides),
    graph: { schemaVersion: 1, nodes: [{ id: 'test', type: 'qa', label: 'Test API', position: { x: 0, y: 0 }, config: {} }], edges: [] },
    nodes: [
      { nodeId: 'test', taskKeys: ['test'], status: 'failed', startedAt: '2026-10-16T10:00:15Z', finishedAt: '2026-10-16T10:00:45Z', durationMs: 30000, attempts: 2, providerId: null, model: null, costUsd: null, error: 'Node failed' },
      { nodeId: 'publish', taskKeys: [], status: 'not_started', startedAt: null, finishedAt: null, durationMs: null, attempts: 0, providerId: null, model: null, costUsd: null, error: null },
    ],
    tasks: [taskFixture({ key: 'test', error: 'Assertion failed in task', status: 'failed' })],
    entries: [
      { id: 1, at: '2026-10-16T10:00:00Z', type: 'run.created', level: 'info', message: 'Run started', nodeId: null, taskId: null },
      { id: 2, at: '2026-10-16T10:00:45Z', type: 'task.updated', level: 'error', message: 'Task failed', nodeId: 'test', taskId: 'task-a' },
    ],
  };
}

beforeEach(() => {
  window.history.replaceState(null, '', '#/runs');
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ projects: [projectFixture()], live: liveSnapshot(), events: [], init: vi.fn(async () => {}) });
});

afterEach(() => { vi.useRealTimers(); });

describe('Runs history', () => {
  it('renders API rows, project names, measured cost and task counts', async () => {
    installFetchMock({ 'GET /api/v2/runs': { runs: [run(), run({ id: 'run-2', number: 2, projectId: 'missing', costUsd: 0.25 })], nextBefore: null } });
    render(<Runs />);
    const table = await screen.findByRole('table', { name: 'Run history' });
    for (const text of ['Atlas', 'missing', 'Build API v2', 'Failed', 'manual', '1m 0s', 'not reported', '$0.25', '1/2', 'Tests failed']) {
      expect(within(table).getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(within(table).getByRole('link', { name: '#1' }).getAttribute('href')).toBe('#/runs/run-1');
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  });

  it('changes the full query for project and status filters', async () => {
    const network = installFetchMock({
      'GET /api/v2/runs': { runs: [run()], nextBefore: null },
      'GET /api/v2/runs?projectId=project-1': { runs: [], nextBefore: null },
      'GET /api/v2/runs?projectId=project-1&status=running': { runs: [], nextBefore: null },
      'GET /api/v2/runs?status=running': { runs: [], nextBefore: null },
    });
    render(<Runs />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'project-1' } });
    await screen.findByText('No runs yet');
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'running' } });
    await waitFor(() => expect(network.calls.at(-1)?.path).toBe('/api/v2/runs?projectId=project-1&status=running'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: '' } });
    await waitFor(() => expect(network.calls.at(-1)?.path).toBe('/api/v2/runs?status=running'));
  });

  it('loads older runs using the startedAt cursor and keeps previous rows', async () => {
    const before = '2026-10-16T10:00:00Z';
    const network = installFetchMock({
      'GET /api/v2/runs': { runs: [run({ number: 2 })], nextBefore: before },
      'GET /api/v2/runs?before=2026-10-16T10%3A00%3A00Z': { runs: [run({ id: 'older', number: 1 })], nextBefore: null },
    });
    render(<Runs />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: '#1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '#2' })).toBeTruthy();
    expect(network.calls.at(-1)?.path).toBe(`/api/v2/runs?before=${encodeURIComponent(before)}`);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows loading, allows retry after failure, and links the empty state to the builder', async () => {
    let failed = true;
    installFetchMock({ 'GET /api/v2/runs': () => failed ? { status: 500, json: { error: 'Runs unavailable' } } : { json: { runs: [], nextBefore: null } } });
    render(<Runs />);
    expect(screen.getByLabelText('Loading runs').getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByRole('alert')).toBeTruthy();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('No runs yet');
    fireEvent.click(screen.getByRole('button', { name: 'Open Workflow Builder' }));
    expect(useStudio.getState().view).toBe('builder');
  });

  it('refreshes on run events at most once per two seconds and unsubscribes', async () => {
    vi.useFakeTimers();
    const network = installFetchMock({ 'GET /api/v2/runs': { runs: [run()], nextBefore: null } });
    const mounted = render(<Runs />);
    await act(async () => {});
    const emit = () => useStudio.setState((state) => ({ events: [...state.events, eventFixture({ type: 'run.updated' })] }));
    act(() => { emit(); emit(); });
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(network.calls).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(network.calls).toHaveLength(2);
    act(() => { emit(); emit(); });
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(network.calls).toHaveLength(3);
    act(emit);
    mounted.unmount();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(network.calls).toHaveLength(3);
  });

  it('renders the existing monitor in the Live tab', async () => {
    installFetchMock({ 'GET /api/v2/runs': { runs: [], nextBefore: null } });
    render(<Runs />);
    await screen.findByText('No runs yet');
    fireEvent.click(screen.getByRole('tab', { name: 'Live' }));
    expect(screen.getByRole('heading', { name: 'Live monitor' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No runs yet')).toBeTruthy();
  });
});

describe('Run detail', () => {
  function openDetail(item = timeline()) {
    window.history.replaceState(null, '', '#/runs/run-1');
    const network = installFetchMock({
      'GET /api/v2/runs/run-1/timeline': item,
      'POST /api/v2/runs/run-1/cancel': { run: run({ status: 'cancelled' }) },
      'GET /api/projects/project-1': { project: projectFixture(), tasks: [], agents: [], approvals: [], recentEvents: [] },
    });
    render(<Runs />);
    return network;
  }

  it('reads the hash and renders failed steps first, positioned node bars and ordered events', async () => {
    openDetail();
    expect(await screen.findByRole('heading', { name: 'Run #1 · Atlas · Build API v2' })).toBeTruthy();
    const headings = screen.getAllByRole('heading').map((item) => item.textContent);
    expect(headings.indexOf('Failed steps')).toBeLessThan(headings.indexOf('Node timeline'));
    expect(screen.getByText('Assertion failed in task')).toBeTruthy();
    const bar = screen.getByRole('img', { name: 'Test API: failed, 30s, ×2' });
    expect(bar.style.left).toBe('25%');
    expect(bar.style.width).toBe('50%');
    expect(screen.getByText('Not started')).toBeTruthy();
    const events = within(screen.getByRole('list', { name: 'Run events' })).getAllByRole('listitem');
    expect(events[0].textContent).toContain('info');
    expect(events[0].textContent).toContain('Run started');
    expect(events[1].textContent).toContain('Task failed');
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });

  it('posts explicit cancellation only after confirmation, then reloads', async () => {
    const network = openDetail(timeline({ status: 'running', finishedAt: null }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const button = await screen.findByRole('button', { name: 'Cancel run' });
    fireEvent.click(button);
    expect(network.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    confirm.mockReturnValue(true);
    fireEvent.click(button);
    await waitFor(() => expect(network.calls).toContainEqual({ method: 'POST', path: '/api/v2/runs/run-1/cancel', body: { confirm: true } }));
    await waitFor(() => expect(network.calls.filter((call) => call.method === 'GET')).toHaveLength(2));
  });

  it('selects the project before opening its tasks', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Open tasks' }));
    await waitFor(() => expect(useStudio.getState().view).toBe('tasks'));
    expect(useStudio.getState().currentProjectId).toBe('project-1');
  });

  it('opens the saved workflow in the builder', async () => {
    openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Workflow Builder' }));
    await waitFor(() => expect(window.location.hash).toBe('#/builder/wf-1'));
    expect(useStudio.getState().currentProjectId).toBe('project-1');
  });

  it('explains why a missing workflow cannot be opened', async () => {
    openDetail(timeline({ workflowId: null }));
    const button = await screen.findByRole('button', { name: 'Open in Workflow Builder' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('This run has no saved workflow.')).toBeTruthy();
  });

  it('limits rendered events to the newest 500', async () => {
    const item = timeline();
    item.entries = Array.from({ length: 510 }, (_, id) => ({ ...item.entries[0], id, message: `Event ${id}` }));
    openDetail(item);
    const list = await screen.findByRole('list', { name: 'Run events' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(500);
    expect(screen.queryByText('Event 9')).toBeNull();
    expect(screen.getByText('Event 509')).toBeTruthy();
  });

  it('navigates between list and detail on hash changes', async () => {
    installFetchMock({
      'GET /api/v2/runs': { runs: [run()], nextBefore: null },
      'GET /api/v2/runs/run-1/timeline': timeline(),
    });
    render(<Runs />);
    await screen.findByRole('table');
    await act(async () => { window.location.hash = '#/runs/run-1'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('heading', { name: /Run #1 ·/ })).toBeTruthy();
    await act(async () => { window.location.hash = '#/runs'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});

describe('App run routes', () => {
  it.each(['#/live', '#/monitor'])('%s opens the monitor', async (hash) => {
    window.history.replaceState(null, '', hash);
    useStudio.setState({ view: viewFromHash(hash) });
    installFetchMock({});
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Live monitor' })).toBeTruthy();
  });

  it('#/runs/<id> opens run detail through the lazy page', async () => {
    window.history.replaceState(null, '', '#/runs/run-1');
    useStudio.setState({ view: viewFromHash(window.location.hash) });
    installFetchMock({ 'GET /api/v2/runs/run-1/timeline': timeline() });
    render(<App />);
    expect(hashParam(window.location.hash)).toBe('run-1');
    expect(await screen.findByRole('heading', { name: /Run #1 ·/ })).toBeTruthy();
  });
});
