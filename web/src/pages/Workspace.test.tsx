import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AGENT_ROLES, type AgentSession, type CreateSessionInput, type WorkspaceLayout } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayout, setPanelSession } from '@/features/workspace/layout';
import { LAYOUT_SAVE_DEBOUNCE_MS, handleSessionEvent, useSessions } from '@/features/workspace/sessionsStore';
import { useStudio } from '@/store/studio';
import { installFetchMock, type FetchCall } from '@/test/fetchMock';
import { agentConfig, healthFixture, overviewFixture, provider, providers, usageFixture } from '@/test/fixtures';
import { budgetFixture, eventFixture, projectFixture, sessionFixture, taskFixture, turnFixture } from '@/test/sessionFixtures';
import { Workspace } from './Workspace';

// jsdom has no ResizeObserver, which react-resizable-panels needs to measure its groups.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const LAYOUT = '/api/v2/projects/project-1/workspace-layout';
const TURNS = (id: string) => `/api/v2/sessions/${id}/turns?limit=50`;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  (document.defaultView as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
  useSessions.getState().reset();
  const project = projectFixture();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({
    currentProjectId: 'project-1', projects: [project], providers, agentConfigs: [agentConfig],
    snapshot: { project, tasks: [], agents: [], approvals: [], recentEvents: [] },
  });
});

afterEach(() => {
  delete (document.defaultView as unknown as Record<string, unknown>).ResizeObserver;
});

interface Setup {
  sessions?: AgentSession[];
  layout?: WorkspaceLayout | null;
  extra?: Record<string, unknown>;
  budget?: unknown;
}

/** Mocks every endpoint the page reads when it opens. Turn routes default to an empty transcript per session. */
function mockServer({ sessions = [], layout = null, extra = {}, budget = budgetFixture() }: Setup = {}) {
  const routes: Record<string, unknown> = {
    [`GET /api/v2/projects/project-1/sessions`]: sessions,
    [`GET ${LAYOUT}`]: layout,
    [`PUT ${LAYOUT}`]: {},
    'GET /api/v2/budget': budget,
    'GET /api/v2/usage/summary?range=24h': usageFixture(),
    'GET /api/v2/system/health': healthFixture(),
    ...Object.fromEntries(sessions.map((s) => [`GET ${TURNS(s.id)}`, { turns: [], nextBefore: null }])),
    ...extra,
  };
  return installFetchMock(routes);
}

const frames = () => Array.from(document.querySelectorAll('[data-panel-frame]'));
const puts = (calls: FetchCall[]) => calls.filter((c) => c.method === 'PUT' && c.path === LAYOUT);
const panelOf = (title: string) => screen.getByRole('region', { name: title });

async function openWorkspace(setup: Setup = {}) {
  const network = mockServer(setup);
  render(<Workspace />);
  await waitFor(() => expect(frames().length).toBeGreaterThan(0));
  return network;
}

const withSession = (sessionId = 's1', count: 1 | 2 | 3 | 4 | 5 | 6 | 8 = 2) => setPanelSession(createLayout(count), 'p1', sessionId);

describe('Workspace page', () => {
  it('shows a call to action when no project is selected', () => {
    useStudio.setState({ currentProjectId: null, snapshot: null });
    const network = installFetchMock({});
    render(<Workspace />);
    expect(screen.getByText('No project selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Projects' }));
    expect(useStudio.getState().view).toBe('projects');
    expect(network.calls).toEqual([]);
  });

  it('starts with one empty "Start a session" panel when no layout was saved', async () => {
    await openWorkspace();
    expect(frames()).toHaveLength(1);
    expect(screen.getByText('Start a session')).toBeTruthy();
    expect((screen.getByLabelText('Layout preset') as HTMLSelectElement).value).toBe('1');
  });

  it('renders N panels when the layout preset changes, keeping existing sessions', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2) });
    expect(frames()).toHaveLength(2);
    expect(within(panelOf('Backend work')).getByText('Idle')).toBeTruthy();
    const select = screen.getByLabelText('Layout preset');
    fireEvent.change(select, { target: { value: '4' } });
    expect(frames()).toHaveLength(4);
    expect(screen.getByRole('region', { name: 'Backend work' })).toBeTruthy();
    fireEvent.change(select, { target: { value: '1' } });
    expect(frames()).toHaveLength(1);
    // the dropped empty panels leave no trace, the first panel (with the session) stays
    expect(screen.getByRole('region', { name: 'Backend work' })).toBeTruthy();
  });

  it('moves a session from a dropped panel to "Recently closed" and reopens it from the dock', async () => {
    const layout = setPanelSession(createLayout(2), 'p2', 's1');
    await openWorkspace({ sessions: [sessionFixture()], layout });
    fireEvent.change(screen.getByLabelText('Layout preset'), { target: { value: '1' } });
    expect(screen.queryByRole('region', { name: 'Backend work' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recently closed' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Backend work' }));
    expect(screen.getByRole('region', { name: 'Backend work' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Dock' })).toBeNull();
  });
});

describe('New Session dialog', () => {
  it('posts a CreateSessionInput and shows the new session in the empty panel', async () => {
    const created = sessionFixture({ id: 's2', number: 2, title: 'Backend session', model: 'claude-default' });
    const network = await openWorkspace({
      extra: {
        'POST /api/v2/projects/project-1/sessions': created,
        [`GET ${TURNS('s2')}`]: { turns: [], nextBefore: null },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    // Backend is the default role: it edits in its own worktree
    expect(within(dialog).getByRole('radio', { name: /Edit in own worktree/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(within(dialog).getByLabelText('Title (optional)'), { target: { value: 'Backend session' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(screen.getByRole('region', { name: 'Backend session' })).toBeTruthy());
    const post = network.calls.find((c) => c.method === 'POST' && c.path === '/api/v2/projects/project-1/sessions');
    expect(post?.body).toEqual({
      title: 'Backend session', role: 'backend', providerId: 'claude-code', model: 'claude-default', effort: '', mode: 'edit',
    } satisfies CreateSessionInput);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('defaults read-only roles to Read-only and sends the chosen model and effort', async () => {
    const network = await openWorkspace({ extra: { 'POST /api/v2/projects/project-1/sessions': sessionFixture({ id: 's3', role: 'architect' }), [`GET ${TURNS('s3')}`]: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'architect' } });
    expect(within(dialog).getByRole('radio', { name: /Read-only/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'claude-saved' }));
    fireEvent.change(within(dialog).getByLabelText('Reasoning effort'), { target: { value: 'high' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(network.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(network.calls.find((c) => c.method === 'POST')?.body).toEqual({
      role: 'architect', providerId: 'claude-code', model: 'claude-saved', effort: 'high', mode: 'readonly',
    });
  });

  it('disables providers that are disabled or unavailable and shows why', async () => {
    useStudio.setState({
      providers: [provider(), provider({ id: 'codex', label: 'Codex', available: false, reason: 'not installed' }), provider({ id: 'gemini', label: 'Gemini', enabled: false })],
    });
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    const options = within(dialog).getAllByRole('option') as HTMLOptionElement[];
    const byText = (text: RegExp) => options.find((o) => text.test(o.textContent ?? ''))!;
    expect(byText(/^Codex/).disabled).toBe(true);
    expect(byText(/^Codex/).textContent).toContain('not installed');
    expect(byText(/^Gemini/).disabled).toBe(true);
    expect(byText(/^Gemini/).textContent).toContain('disabled');
    expect(byText(/^Claude Code/).disabled).toBe(false);
  });

  it('shows the server error and keeps the dialog open', async () => {
    await openWorkspace({ extra: { 'POST /api/v2/projects/project-1/sessions': () => ({ status: 400, json: { error: 'Provider is not available' } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'New Session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Provider is not available');
  });
});

describe('Session panel chat', () => {
  const MESSAGE = 'Please add a search endpoint';

  it('posts to /messages on Ctrl+Enter and shows the user turn', async () => {
    let sent = false;
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: {
        [`GET ${TURNS('s1')}`]: () => ({ json: { turns: sent ? [turnFixture({ text: MESSAGE })] : [], nextBefore: null } }),
        'POST /api/v2/sessions/s1/messages': () => { sent = true; return { json: { id: 's1' } }; },
      },
    });
    const box = screen.getByLabelText('Message to Backend work') as HTMLTextAreaElement;
    await screen.findByText(/No agent process exists until you send/);
    fireEvent.change(box, { target: { value: MESSAGE } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText(MESSAGE)).toBeTruthy();
    await waitFor(() => expect(box.value).toBe(''));
    const post = network.calls.find((c) => c.method === 'POST' && c.path === '/api/v2/sessions/s1/messages');
    expect(post?.body).toEqual({ text: MESSAGE });
    expect(network.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('shows a 409 inline, drops the optimistic turn and keeps the draft', async () => {
    await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: { 'POST /api/v2/sessions/s1/messages': () => ({ status: 409, json: { error: 'A turn is already running' } }) },
    });
    const box = screen.getByLabelText('Message to Backend work') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: MESSAGE } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await within(panelOf('Backend work')).findByRole('alert');
    expect(alert.textContent).toBe('This session is busy: A turn is already running');
    expect(screen.queryByText(MESSAGE, { selector: 'p' })).toBeNull();
    expect(box.value).toBe(MESSAGE);
  });

  it('renders the transcript and live output of a running turn', async () => {
    await openWorkspace({
      sessions: [sessionFixture({ status: 'running' })], layout: withSession(),
      extra: { [`GET ${TURNS('s1')}`]: { turns: [turnFixture({ text: 'Build it' })], nextBefore: null } },
    });
    expect(await screen.findByText('Build it')).toBeTruthy();
    act(() => handleSessionEvent(eventFixture({ type: 'session.output', data: { sessionId: 's1', chunk: 'Editing src/app.ts' } })));
    expect(await screen.findByText('Editing src/app.ts')).toBeTruthy();
    // a running turn cannot take a second message
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows "Queued #n" from the process budget', async () => {
    await openWorkspace({
      sessions: [sessionFixture({ status: 'queued', queuePosition: null })], layout: withSession(),
      budget: budgetFixture({
        running: [{ kind: 'task', id: 't1', projectId: 'project-1', label: 'Implement search' }],
        queued: [{ kind: 'session', id: 's1', projectId: 'project-1', label: 'Backend work', position: 2, since: '2026-10-16T10:00:00Z' }],
      }),
    });
    expect(await within(panelOf('Backend work')).findByText('Queued #2')).toBeTruthy();
    expect((await screen.findByText(/1 \/ 3 · 1 queued/))).toBeTruthy();
  });

  it('shows header chips for provider, cwd and continuity', async () => {
    await openWorkspace({ sessions: [sessionFixture({ effort: 'high', continuity: 'replay' })], layout: withSession() });
    const panel = panelOf('Backend work');
    expect(within(panel).getByText('Claude Code · claude-default · high')).toBeTruthy();
    expect(within(panel).getByText('cwd: session-1 · asf/atlas/session-1')).toBeTruthy();
    expect(within(panel).getByText('context replay')).toBeTruthy();
  });
});

describe('Session actions', () => {
  async function openMenu() {
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: { 'POST /api/v2/sessions/s1/merge': sessionFixture({ status: 'idle' }), 'POST /api/v2/sessions/s1/stop': {} },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Panel actions for Backend work' }));
    return network;
  }

  it('merges into integration after confirm() with { confirm: true }', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const network = await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Merge into integration' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('asf/atlas/session-1');
    await waitFor(() => expect(network.calls.some((c) => c.path === '/api/v2/sessions/s1/merge')).toBe(true));
    expect(network.calls.find((c) => c.path === '/api/v2/sessions/s1/merge')).toEqual({ method: 'POST', path: '/api/v2/sessions/s1/merge', body: { confirm: true } });
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const network = await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard worktree' }));
    expect(network.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('disables worktree actions for read-only sessions with a reason', async () => {
    await openWorkspace({ sessions: [sessionFixture({ mode: 'readonly', cwdKind: 'integration', branch: null })], layout: withSession() });
    expect(screen.queryByRole('tab', { name: 'Changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Panel actions for Backend work' }));
    const merge = screen.getByRole('menuitem', { name: /Merge into integration/ });
    expect(merge.getAttribute('aria-disabled')).toBe('true');
    expect(merge.textContent).toContain('Only edit sessions have a worktree');
  });

  it('stops a running turn without confirmation', async () => {
    const network = await openWorkspace({
      sessions: [sessionFixture({ status: 'running' })], layout: withSession(), extra: { 'POST /api/v2/sessions/s1/stop': {} },
    });
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(network.calls.some((c) => c.path === '/api/v2/sessions/s1/stop')).toBe(true));
    expect(network.calls.find((c) => c.path === '/api/v2/sessions/s1/stop')?.body).toEqual({});
  });

  it('renames a session inline with PATCH', async () => {
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: { 'PATCH /api/v2/sessions/s1': sessionFixture({ title: 'API work' }) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Panel actions for Backend work' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Session title');
    fireEvent.change(input, { target: { value: 'API work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'API work' })).toBeTruthy());
    expect(network.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: 'API work' });
  });
});

describe('Session tabs', () => {
  it('shows the Task tab only for a linked task', async () => {
    useStudio.setState({ snapshot: { project: projectFixture(), tasks: [taskFixture({ id: 'task-a', title: 'Write the technical plan' })], agents: [], approvals: [], recentEvents: [] } });
    await openWorkspace({ sessions: [sessionFixture({ taskId: 'task-a' })], layout: withSession() });
    fireEvent.click(screen.getByRole('tab', { name: 'Task' }));
    expect(await screen.findByText('Write the technical plan')).toBeTruthy();
  });

  it('lists tool activity from the transcript', async () => {
    await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: { [`GET ${TURNS('s1')}`]: { turns: [turnFixture({ author: 'agent', seq: 2, id: 2, activity: ['Editing src/app.ts'] })], nextBefore: null } },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Editing src/app.ts')).toBeTruthy();
  });

  it('shows the diff per file in the Changes tab', async () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession(), extra: { 'GET /api/v2/sessions/s1/diff': { diff } } });
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(await screen.findByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('+new')).toBeTruthy();
  });

  it('lists files read-only and shows the server message for a protected file (403)', async () => {
    await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: {
        'GET /api/v2/sessions/s1/files': { files: ['src/a.ts', '.env'] },
        'GET /api/v2/sessions/s1/file?path=src%2Fa.ts': { content: 'export const a = 1;' },
        'GET /api/v2/sessions/s1/file?path=.env': () => ({ status: 403, json: { error: 'Sensitive file: .env cannot be read' } }),
      },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }));
    expect((await screen.findByLabelText('Content of src/a.ts')).textContent).toBe('export const a = 1;');
    fireEvent.click(screen.getByRole('button', { name: '.env' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Protected file — Sensitive file: .env cannot be read');
  });

  it('runs tests and shows the output without ANSI codes', async () => {
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: withSession(),
      extra: { 'POST /api/v2/sessions/s1/run-tests': { output: '\u001b[32mPASS\u001b[0m src/a.test.ts\n\u001b[1mTests: 3 passed\u001b[22m' } },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
    const output = await screen.findByLabelText('Test output');
    expect(output.textContent).toBe('PASS src/a.test.ts\nTests: 3 passed');
    expect(network.calls.find((c) => c.path === '/api/v2/sessions/s1/run-tests')?.method).toBe('POST');
  });
});

describe('Layout behaviour', () => {
  it('saves the layout with one debounced PUT after the last change', async () => {
    const network = await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2) });
    const select = screen.getByLabelText('Layout preset');
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.change(select, { target: { value: '3' } });
    expect(puts(network.calls)).toHaveLength(0);
    await waitFor(() => expect(puts(network.calls)).toHaveLength(1), { timeout: LAYOUT_SAVE_DEBOUNCE_MS + 1500 });
    const saved = puts(network.calls)[0].body as WorkspaceLayout;
    expect(saved.preset).toBe(3);
    expect(Object.keys(saved.panels)).toHaveLength(3);
    expect(saved.panels.p1.sessionId).toBe('s1');
  });

  it('does not save a layout that was only loaded', async () => {
    const network = await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2) });
    await new Promise((resolve) => setTimeout(resolve, LAYOUT_SAVE_DEBOUNCE_MS + 200));
    expect(puts(network.calls)).toHaveLength(0);
  });

  it('maximizes on header double-click and restores with Escape', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 3) });
    expect(frames()).toHaveLength(3);
    fireEvent.doubleClick(panelOf('Backend work').querySelector('header')!);
    expect(frames()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Restore Backend work' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(frames()).toHaveLength(3);
  });

  it('maximizes the active panel with Ctrl+Shift+M', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2) });
    fireEvent.mouseDown(panelOf('Backend work'));
    fireEvent.keyDown(document, { key: 'M', ctrlKey: true, shiftKey: true });
    expect(frames()).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'M', ctrlKey: true, shiftKey: true });
    expect(frames()).toHaveLength(2);
  });

  it('minimizes a panel to the dock and restores it from there', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2) });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize Backend work' }));
    expect(screen.queryByRole('region', { name: 'Backend work' })).toBeNull();
    const dock = screen.getByRole('navigation', { name: 'Dock' });
    fireEvent.click(within(dock).getByRole('button', { name: 'Backend work' }));
    expect(screen.getByRole('region', { name: 'Backend work' })).toBeTruthy();
  });

  it('turns an empty panel into the Studio Orchestrator with timeline and slots', async () => {
    useStudio.setState({
      events: [
        eventFixture({ type: 'task.updated', message: 'Implement search started' }),
        eventFixture({ type: 'provider.fallback', level: 'warn', message: 'Falling back to Codex' }),
        eventFixture({ type: 'agent.output', message: 'noise' }),
      ],
    });
    await openWorkspace({
      budget: budgetFixture({ running: [{ kind: 'task', id: 't1', projectId: 'project-1', label: 'Implement search' }] }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Studio Orchestrator/ }));
    const timeline = await screen.findByRole('region', { name: 'Scheduler timeline' });
    expect(within(timeline).getByText(/Falling back to Codex/)).toBeTruthy();
    expect(within(timeline).queryByText(/noise/)).toBeNull();
    expect((await screen.findByRole('region', { name: 'Process budget' })).textContent).toContain('1 / 3');
  });

  it('pauses and cancels the run from the orchestrator panel', async () => {
    const layout = createLayout(1);
    layout.panels.p1 = { sessionId: null, tab: 'chat', kind: 'orchestrator' };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const network = await openWorkspace({
      layout,
      extra: {
        'POST /api/projects/project-1/pause': {}, 'POST /api/projects/project-1/cancel': {},
        'GET /api/projects/project-1': { project: projectFixture(), tasks: [], agents: [], approvals: [], recentEvents: [] },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(network.calls.some((c) => c.path === '/api/projects/project-1/pause')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(network.calls.some((c) => c.path === '/api/projects/project-1/cancel')).toBe(true));
  });
});

describe('Process budget rule', () => {
  it('8 open panels make no session request except the list and the transcripts', async () => {
    const sessions = Array.from({ length: 8 }, (_, index) => sessionFixture({ id: `s${index + 1}`, number: index + 1, title: `Session ${index + 1}` }));
    let layout = createLayout(8);
    sessions.forEach((session, index) => { layout = setPanelSession(layout, `p${index + 1}`, session.id); });
    const network = await openWorkspace({ sessions, layout });
    await waitFor(() => expect(network.calls.filter((c) => /\/turns\?limit=50$/.test(c.path))).toHaveLength(8));
    expect(frames()).toHaveLength(8);
    expect(network.calls.every((c) => c.method === 'GET')).toBe(true);
    const sessionCalls = network.calls.filter((c) => c.path.startsWith('/api/v2/sessions/'));
    expect(sessionCalls.every((c) => /^\/api\/v2\/sessions\/s[1-8]\/turns\?limit=50$/.test(c.path))).toBe(true);
    expect(sessionCalls).toHaveLength(8);
  });

  it('falls back to a fresh layout when the saved one is unusable', async () => {
    await openWorkspace({ layout: { version: 9, nonsense: true } as unknown as WorkspaceLayout });
    expect(frames()).toHaveLength(1);
  });
});

describe('Coordination drawer', () => {
  const drawerLayout = (): WorkspaceLayout => {
    const layout = withSession('s1', 2);
    return { ...layout, drawer: { ...layout.drawer, open: true } };
  };

  const drawerRoutes = (extra: Record<string, unknown> = {}) => ({
    'GET /api/v2/overview?projectId=project-1': overviewFixture(),
    ...Object.fromEntries(AGENT_ROLES.map((role) => [`GET /api/projects/project-1/agents/${role}/messages`, []])),
    ...extra,
  });

  it('opens and closes with Ctrl+.', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: withSession('s1', 2), extra: drawerRoutes() });
    expect(screen.queryByRole('complementary', { name: 'Coordination drawer' })).toBeNull();
    fireEvent.keyDown(document, { key: '.', ctrlKey: true });
    expect(await screen.findByRole('complementary', { name: 'Coordination drawer' })).toBeTruthy();
    fireEvent.keyDown(document, { key: '.', ctrlKey: true });
    expect(screen.queryByRole('complementary', { name: 'Coordination drawer' })).toBeNull();
  });

  it('derives task handoffs from the task events', async () => {
    const architect = taskFixture();
    const backend = taskFixture({
      id: 'task-b', key: 'impl', title: 'Implement search', role: 'backend', kind: 'implement', status: 'running', dependsOn: ['plan'],
      startedAt: '2026-10-16T10:06:00Z', finishedAt: null, updatedAt: '2026-10-16T10:06:00Z',
    });
    useStudio.setState({ events: [eventFixture({ data: { task: architect } }), eventFixture({ data: { task: backend } })] });
    await openWorkspace({ sessions: [sessionFixture()], layout: drawerLayout(), extra: drawerRoutes() });
    const handoffs = await screen.findByRole('region', { name: 'Task handoffs' });
    const row = handoffs.querySelector('[data-handoff="task-a>task-b"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByText('Architect')).toBeTruthy();
    expect(within(row).getByText('Backend')).toBeTruthy();
    expect(within(row).getByText(/Write the technical plan/)).toBeTruthy();
  });

  it('shows the current workflow stages from the overview', async () => {
    await openWorkspace({ sessions: [sessionFixture()], layout: drawerLayout(), extra: drawerRoutes() });
    const workflow = await screen.findByRole('region', { name: 'Current workflow' });
    expect(await within(workflow).findByText('Implement search')).toBeTruthy();
    expect(within(workflow).getByText('Run the test suite')).toBeTruthy();
  });

  it('posts "Message all agents" to the orchestrator and forwards only ticked sessions', async () => {
    const sessions = [sessionFixture(), sessionFixture({ id: 's2', number: 2, title: 'Reviewer chat', role: 'reviewer' })];
    const network = await openWorkspace({
      sessions, layout: drawerLayout(),
      extra: drawerRoutes({ 'POST /api/v2/projects/project-1/orchestrator/messages': {} }),
    });
    const section = await screen.findByRole('region', { name: 'Message all agents' });
    fireEvent.change(within(section).getByLabelText('Message to the orchestrator'), { target: { value: 'Freeze the API' } });
    fireEvent.click(within(section).getByRole('checkbox', { name: 'Reviewer chat' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Send' }));
    expect(await within(section).findByText(/forwarded to 1 session/)).toBeTruthy();
    expect(network.calls.find((c) => c.path === '/api/v2/projects/project-1/orchestrator/messages')?.body).toEqual({ text: 'Freeze the API', forwardTo: ['s2'] });
  });

  it('forwards to nobody unless sessions are ticked', async () => {
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: drawerLayout(),
      extra: drawerRoutes({ 'POST /api/v2/projects/project-1/orchestrator/messages': {} }),
    });
    const section = await screen.findByRole('region', { name: 'Message all agents' });
    fireEvent.change(within(section).getByLabelText('Message to the orchestrator'), { target: { value: 'Status?' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(network.calls.some((c) => c.path.endsWith('/orchestrator/messages'))).toBe(true));
    expect(network.calls.find((c) => c.path.endsWith('/orchestrator/messages'))?.body).toEqual({ text: 'Status?', forwardTo: [] });
  });

  it('decides a pending approval inline', async () => {
    const project = projectFixture();
    useStudio.setState({
      snapshot: {
        project, tasks: [], agents: [], recentEvents: [],
        approvals: [{ id: 'ap1', projectId: 'project-1', taskId: null, kind: 'plan', status: 'pending', title: 'Approve the plan', details: {}, note: null, createdAt: '2026-10-16T10:00:00Z', decidedAt: null }],
      },
    });
    const network = await openWorkspace({
      sessions: [sessionFixture()], layout: drawerLayout(),
      extra: drawerRoutes({
        'POST /api/approvals/ap1/decision': {},
        'GET /api/projects/project-1': { project, tasks: [], agents: [], approvals: [], recentEvents: [] },
      }),
    });
    const section = await screen.findByRole('region', { name: 'Approval requests' });
    expect(within(section).getByText('Approve the plan')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(network.calls.some((c) => c.path === '/api/approvals/ap1/decision')).toBe(true));
    expect(network.calls.find((c) => c.path === '/api/approvals/ap1/decision')?.body).toEqual({ decision: 'approved', note: null });
  });

  it('lists blocked and failed work, and merged files under Artifacts', async () => {
    useStudio.setState({
      snapshot: {
        project: projectFixture(), agents: [], approvals: [], recentEvents: [],
        tasks: [taskFixture({ id: 'bad', title: 'Run the test suite', status: 'failed', error: 'Tests failed: 3 failing' })],
      },
      events: [eventFixture({ type: 'git.merge', role: 'backend', data: { files: ['server/search.ts'] } })],
    });
    await openWorkspace({ sessions: [sessionFixture({ status: 'failed', lastError: 'Provider crashed' })], layout: drawerLayout(), extra: drawerRoutes() });
    const blocked = await screen.findByRole('region', { name: 'Blocked tasks & errors' });
    expect(within(blocked).getByText('Tests failed: 3 failing')).toBeTruthy();
    expect(within(blocked).getByText('Provider crashed')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    expect(await screen.findByText('server/search.ts')).toBeTruthy();
  });
});

describe('Status bar', () => {
  it('shows sessions, slots, tokens (24 h), CPU and RAM from real endpoints', async () => {
    await openWorkspace({
      sessions: [sessionFixture({ status: 'running' }), sessionFixture({ id: 's2', number: 2, status: 'queued' })],
      layout: withSession(),
      budget: budgetFixture({ running: [{ kind: 'session', id: 's1', projectId: 'project-1', label: 'Backend work' }], limit: 3 }),
    });
    const bar = await screen.findByRole('group', { name: 'Workspace status' });
    expect(within(bar).getByText('Atlas')).toBeTruthy();
    expect(within(bar).getByText('1 running · 1 queued')).toBeTruthy();
    expect(await within(bar).findByText('18.4k')).toBeTruthy();
    expect(within(bar).getByText('12%')).toBeTruthy();
    expect(within(bar).getByText('50%')).toBeTruthy();
    expect(within(bar).getByText('1 / 3 · 0 queued')).toBeTruthy();
  });
});
