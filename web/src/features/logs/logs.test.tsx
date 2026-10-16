import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EventsPage, LogQuery, StudioEvent } from '@asf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logs } from '@/pages/Logs';
import { useStudio } from '@/store/studio';
import { eventFixture, projectFixture, sessionFixture } from '@/test/sessionFixtures';
import * as workflowsApi from '@/features/workflows/workflowsApi';
import { buildLogQuery, initialFilters, matchesFilters } from './LogFilters';
import * as api from './logsApi';
import { VirtualRows, windowRange, type VirtualRowsProps } from './VirtualRows';

vi.mock('./logsApi');
vi.mock('@/features/workflows/workflowsApi');

const mocked = vi.mocked(api);
const mockedRuns = vi.mocked(workflowsApi);

function ev(id: number, overrides: Partial<StudioEvent> = {}): StudioEvent {
  return eventFixture({ id, message: `event message ${id}`, createdAt: '2026-10-16T10:00:00Z', ...overrides });
}

function page(events: StudioEvent[], nextBefore: number | null = null): EventsPage {
  return { events, nextBefore };
}

function setup(first: EventsPage = page([ev(3), ev(2), ev(1)])) {
  mocked.fetchEvents.mockResolvedValue(first);
  mocked.listSessions.mockResolvedValue([sessionFixture({ id: 's1', number: 1, title: 'Backend work' })]);
  mockedRuns.listRuns.mockResolvedValue({ runs: [], nextBefore: null });
}

async function openPage(first?: EventsPage) {
  setup(first);
  render(<Logs />);
  await waitFor(() => expect(mocked.fetchEvents).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByLabelText('Loading events')).toBeNull());
}

const lastQuery = (): LogQuery => mocked.fetchEvents.mock.lastCall?.[0] ?? {};

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function pushLive(...events: StudioEvent[]) {
  act(() => { useStudio.setState({ events: [...useStudio.getState().events, ...events] }); });
}

beforeEach(() => {
  vi.resetAllMocks();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ currentProjectId: 'project-1', projects: [projectFixture(), projectFixture({ id: 'project-2', name: 'Borealis' })] });
});

describe('Logs filters', () => {
  it('loads the header project first and sends only the set filters', async () => {
    await openPage();
    expect(lastQuery()).toMatchObject({ projectId: 'project-1', limit: 200 });
    expect(lastQuery().q).toBeUndefined();
    expect(lastQuery().from).toBeUndefined();
    expect(await screen.findByText('event message 3')).toBeTruthy();
  });

  it('maps role, level, type, search and time range to query params (search is debounced)', async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'backend' } });
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'error' } });
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'task.*' } });
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'boom' } });
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '1h' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ projectId: 'project-1', role: 'backend', level: 'error', type: 'task.*', q: 'boom' }));
    const from = Date.parse(lastQuery().from ?? '');
    expect(Date.now() - from).toBeGreaterThan(59 * 60_000);
    expect(Date.now() - from).toBeLessThan(61 * 60_000);
  });

  it('drops the project filter for "All projects" and enables run/session only for a project', async () => {
    mockedRuns.listRuns.mockResolvedValue({ runs: [], nextBefore: null });
    await openPage();
    await waitFor(() => expect((screen.getByLabelText('Session') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    await waitFor(() => expect(lastQuery().projectId).toBeUndefined());
    expect((screen.getByLabelText('Session') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByLabelText('Session').getAttribute('title')).toBe('Select a project to filter by session');
    expect((screen.getByLabelText('Run') as HTMLSelectElement).disabled).toBe(true);
  });

  it('sends the chosen session', async () => {
    await openPage();
    await screen.findByRole('option', { name: '#1 Backend work' });
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 's1' } });
    await waitFor(() => expect(lastQuery()).toMatchObject({ projectId: 'project-1', sessionId: 's1' }));
  });

  it('buildLogQuery omits empty filters', () => {
    expect(buildLogQuery(initialFilters(''), Date.now())).toEqual({});
  });

  it('matchesFilters mirrors the server rules for live events', () => {
    const base = { ...initialFilters('project-1'), type: 'task.*', level: 'error' as const };
    expect(matchesFilters(ev(1, { type: 'task.updated', level: 'error' }), base)).toBe(true);
    expect(matchesFilters(ev(1, { type: 'run.updated', level: 'error' }), base)).toBe(false);
    expect(matchesFilters(ev(1, { type: 'task.updated', level: 'info' }), base)).toBe(false);
    expect(matchesFilters(ev(1, { type: 'task.updated', level: 'error', projectId: 'project-2' }), base)).toBe(false);
    expect(matchesFilters(ev(1, { message: 'Hello World' }), { ...initialFilters(''), search: 'hello' })).toBe(true);
    expect(matchesFilters(ev(1, { data: { runId: 'r1' } }), { ...initialFilters(''), run: 'r1' })).toBe(true);
    expect(matchesFilters(ev(1), { ...initialFilters(''), run: 'r1' })).toBe(false);
    expect(matchesFilters(ev(1, { type: 'agent.output' }), initialFilters(''))).toBe(false);
  });
});

describe('Logs states', () => {
  it('shows an error with a retry', async () => {
    mocked.fetchEvents.mockRejectedValueOnce(new Error('server down'));
    mocked.listSessions.mockResolvedValue([]);
    mockedRuns.listRuns.mockResolvedValue({ runs: [], nextBefore: null });
    render(<Logs />);
    expect(await screen.findByText('server down')).toBeTruthy();
    mocked.fetchEvents.mockResolvedValue(page([ev(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('event message 1')).toBeTruthy();
  });

  it('explains an empty log, with and without filters', async () => {
    await openPage(page([]));
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'warn' } });
    expect(await screen.findByText('No events match these filters')).toBeTruthy();
  });

  it('hides agent output until asked for', async () => {
    await openPage(page([ev(2, { type: 'agent.output', message: 'raw tokens' }), ev(1)]));
    expect(screen.queryByText('raw tokens')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('1 agent output lines hidden');
    fireEvent.click(screen.getByLabelText('Show agent output'));
    expect(await screen.findByText('raw tokens')).toBeTruthy();
    expect(mocked.fetchEvents).toHaveBeenCalledTimes(1);
  });

  it('loads older events with nextBefore', async () => {
    await openPage(page([ev(9), ev(8)], 7));
    mocked.fetchEvents.mockResolvedValueOnce(page([ev(7), ev(6)], null));
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('event message 6')).toBeTruthy();
    expect(lastQuery()).toMatchObject({ projectId: 'project-1', before: 7 });
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
    const rows = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(rows.findIndex((text) => text.includes('message 9'))).toBeLessThan(rows.findIndex((text) => text.includes('message 6')));
  });

  it('keeps the loaded events and shows a retry when loading older ones fails', async () => {
    await openPage(page([ev(9)], 8));
    mocked.fetchEvents.mockRejectedValueOnce(new Error('timeout'));
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect((await screen.findByRole('alert')).textContent).toContain('timeout');
    expect(screen.getByText('event message 9')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeTruthy();
  });
});

describe('Logs live tail', () => {
  it('prepends matching live events while on and ignores other projects', async () => {
    await openPage();
    pushLive(ev(50, { message: 'fresh live event' }), ev(51, { projectId: 'project-2', message: 'other project event' }));
    expect(await screen.findByText('fresh live event')).toBeTruthy();
    expect(screen.queryByText('other project event')).toBeNull();
    const first = screen.getAllByRole('listitem')[0];
    expect(first.textContent).toContain('fresh live event');
  });

  it('counts new events while paused and shows them on request', async () => {
    await openPage();
    const toggle = screen.getByRole('button', { name: 'Live tail' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    pushLive(ev(50, { message: 'held back' }));
    expect(await screen.findByRole('button', { name: '1 new event' })).toBeTruthy();
    expect(screen.queryByText('held back')).toBeNull();
    pushLive(ev(51, { message: 'second held back' }));
    fireEvent.click(await screen.findByRole('button', { name: '2 new events' }));
    expect(await screen.findByText('held back')).toBeTruthy();
    expect(screen.getByText('second held back')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new event/ })).toBeNull();
  });

  it('flushes the held events when live tail is switched back on', async () => {
    await openPage();
    const toggle = screen.getByRole('button', { name: 'Live tail' });
    fireEvent.click(toggle);
    pushLive(ev(50, { message: 'held back' }));
    await screen.findByRole('button', { name: '1 new event' });
    fireEvent.click(toggle);
    expect(await screen.findByText('held back')).toBeTruthy();
  });

  it('only counts live events that match the filters', async () => {
    await openPage();
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'error' } });
    await waitFor(() => expect(lastQuery().level).toBe('error'));
    await waitFor(() => expect(screen.queryByLabelText('Loading events')).toBeNull());
    pushLive(ev(60, { level: 'info', message: 'quiet info' }), ev(61, { level: 'error', message: 'loud error' }));
    expect(await screen.findByText('loud error')).toBeTruthy();
    expect(screen.queryByText('quiet info')).toBeNull();
  });
});

describe('Logs export', () => {
  it('downloads the loaded events as a JSON blob', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:logs');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) { downloads.push(this.download); });

    await openPage();
    fireEvent.click(screen.getByRole('button', { name: /Export JSON/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe('application/json');
    expect((JSON.parse(await readBlob(blob)) as StudioEvent[]).map((event) => event.id)).toEqual([3, 2, 1]);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^activity-project-1-.*\.json$/);
  });

  it('is disabled with a reason when nothing is loaded', async () => {
    await openPage(page([]));
    const button = screen.getByRole('button', { name: /Export JSON/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('No loaded events to export');
  });
});

describe('Logs details and task link', () => {
  it('shows the pretty-printed data of the selected event and closes again', async () => {
    await openPage(page([ev(2, { message: 'with data', data: { count: 3, nested: { ok: true } } }), ev(1, { message: 'without data' })]));
    fireEvent.click(screen.getByText('with data'));
    const panel = await screen.findByRole('complementary', { name: 'Event details' });
    expect(within(panel).getByText('Event #2')).toBeTruthy();
    expect(within(panel).getByLabelText('Event data').textContent).toBe(JSON.stringify({ count: 3, nested: { ok: true } }, null, 2));

    fireEvent.click(screen.getByText('without data'));
    expect(within(await screen.findByRole('complementary', { name: 'Event details' })).getByText('This event carries no data.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Event details' })).toBeNull();
  });

  it('opens the task in workflows from a row (V1 behaviour)', async () => {
    await openPage(page([ev(2, { taskId: 'task-9', message: 'task event' }), ev(1, { message: 'plain event' })]));
    expect(screen.getAllByRole('button', { name: 'Open task in workflows' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open task in workflows' }));
    expect(useStudio.getState().selectedTaskId).toBe('task-9');
    expect(useStudio.getState().view).toBe('workflows');
  });

  it('opens the task from the details panel as well', async () => {
    await openPage(page([ev(2, { taskId: 'task-9', message: 'task event' })]));
    fireEvent.click(screen.getByText('task event'));
    const panel = await screen.findByRole('complementary', { name: 'Event details' });
    fireEvent.click(within(panel).getByRole('button', { name: /Open task in workflows/ }));
    expect(useStudio.getState().selectedTaskId).toBe('task-9');
    expect(useStudio.getState().view).toBe('workflows');
  });
});

describe('VirtualRows', () => {
  interface Item { id: number; label: string }
  const items: Item[] = Array.from({ length: 10_000 }, (_, index) => ({ id: index, label: `Row ${index}` }));
  const renderRows = (list: Item[] = items, extra: Partial<VirtualRowsProps<Item>> = {}) => (
    <VirtualRows items={list} rowHeight={28} overscan={5} fallbackHeight={280} ariaLabel="rows" getKey={(item) => item.id}
      renderRow={(item) => <span>{item.label}</span>} {...extra} />
  );

  it('renders only a window of 10k items and follows the scroll position', () => {
    render(renderRows());
    const list = screen.getByRole('list', { name: 'rows' });
    const rendered = screen.getAllByRole('listitem');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(20);
    expect(screen.getByText('Row 0')).toBeTruthy();
    expect(screen.queryByText('Row 9999')).toBeNull();
    expect((list.firstElementChild as HTMLElement).style.height).toBe(`${10_000 * 28}px`);

    fireEvent.scroll(list, { target: { scrollTop: 28 * 5000 } });
    expect(screen.getByText('Row 5000')).toBeTruthy();
    expect(screen.queryByText('Row 0')).toBeNull();
    expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(20);
  });

  it('windowRange clamps to the list', () => {
    expect(windowRange(0, 28, 0, 280, 5)).toEqual({ start: 0, end: 0 });
    expect(windowRange(100, 28, 0, 280, 5)).toEqual({ start: 0, end: 15 });
    expect(windowRange(100, 28, 28 * 95, 280, 5)).toEqual({ start: 90, end: 100 });
  });

  it('fires onEndReached once per list length when the end is near', () => {
    const onEndReached = vi.fn();
    const first = items.slice(0, 100);
    const { rerender } = render(renderRows(first, { onEndReached }));
    const list = screen.getByRole('list', { name: 'rows' });
    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    expect(onEndReached).not.toHaveBeenCalled();
    fireEvent.scroll(list, { target: { scrollTop: 28 * 90 } });
    fireEvent.scroll(list, { target: { scrollTop: 28 * 91 } });
    expect(onEndReached).toHaveBeenCalledTimes(1);
    rerender(renderRows(items.slice(0, 200), { onEndReached }));
    fireEvent.scroll(list, { target: { scrollTop: 28 * 190 } });
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it('keeps the visible rows in place when rows are prepended above a scrolled viewport', () => {
    const { rerender } = render(renderRows(items.slice(10, 200)));
    const list = screen.getByRole('list', { name: 'rows' });
    fireEvent.scroll(list, { target: { scrollTop: 280 } });
    rerender(renderRows(items.slice(7, 200)));
    expect(list.scrollTop).toBe(280 + 3 * 28);
  });

  it('stays at the top for prepended rows when the user is at the top', () => {
    const { rerender } = render(renderRows(items.slice(10, 200)));
    const list = screen.getByRole('list', { name: 'rows' });
    rerender(renderRows(items.slice(7, 200)));
    expect(list.scrollTop).toBe(0);
    expect(screen.getByText('Row 7')).toBeTruthy();
  });
});
