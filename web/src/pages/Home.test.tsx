import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OverviewResponse, ProjectSnapshot } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { healthFixture, overviewFixture, provider, serverInfo, usageFixture } from '@/test/fixtures';

const OVERVIEW = '/api/v2/overview?projectId=project-1';
const USAGE_24H = '/api/v2/usage/summary?range=24h';
const USAGE_7D = '/api/v2/usage/summary?range=7d';
const HEALTH = '/api/v2/system/health';

function routes(extra: Record<string, unknown> = {}) {
  return {
    [`GET ${OVERVIEW}`]: overviewFixture(),
    'GET /api/v2/overview': overviewFixture({ currentProject: null }),
    [`GET ${USAGE_24H}`]: usageFixture('24h'),
    [`GET ${USAGE_7D}`]: usageFixture('7d'),
    [`GET ${HEALTH}`]: healthFixture(),
    ...extra,
  };
}

/** The Panel (card) that carries the given heading. */
function panel(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('.rounded-xl') as HTMLElement;
}

/** Renders Home for project-1 and waits until the overview has loaded. */
async function renderHome(extra: Record<string, unknown> = {}) {
  const network = installFetchMock(routes(extra));
  render(<Home />);
  await screen.findByRole('heading', { name: 'Current Project Workflow' });
  return network;
}

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({ info: serverInfo, currentProjectId: 'project-1' });
  // Only Date is faked, so "5m ago" is deterministic while timers and promises stay real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Home', () => {
  it('greets the person by name and falls back to a plain greeting', async () => {
    await renderHome();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back, tester');
    expect(screen.getByRole('button', { name: 'New Project' })).toBeTruthy();
  });

  it('greets without a name when the server sends none', () => {
    useStudio.setState({ info: { ...serverInfo, userName: '' } });
    installFetchMock(routes());
    render(<Home />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back');
  });

  it('shows skeletons while the overview loads', () => {
    installFetchMock(routes());
    render(<Home />);
    expect(screen.getByLabelText('Loading overview')).toBeTruthy();
  });

  it('asks for the overview of the current project and both usage ranges', async () => {
    const network = await renderHome();
    const paths = network.calls.map((call) => call.path);
    expect(paths).toEqual(expect.arrayContaining([OVERVIEW, USAGE_24H, USAGE_7D, HEALTH]));
  });

  it('renders the six KPI cards from the response fields', async () => {
    await renderHome();
    const card = (name: string) => screen.getByRole('group', { name });

    const projects = card('Active projects');
    expect(within(projects).getByText('2')).toBeTruthy();
    expect(within(projects).getByText('+1 in 7 days · 3 total')).toBeTruthy();

    const agents = card('Running agents');
    expect(within(agents).getByText('2 / 4')).toBeTruthy();
    expect(await within(agents).findByText('Degraded')).toBeTruthy();

    expect(within(card('Queued tasks')).getByText('3')).toBeTruthy();

    const open = card('Open tasks');
    expect(within(open).getByText('12')).toBeTruthy();
    expect(within(open).getByText('5 completed in 24 h')).toBeTruthy();

    const failed = card('Failed (24 h)');
    expect(within(failed).getByText('2')).toBeTruthy();
    expect(within(failed).getByText('1 pending approval')).toBeTruthy();

    const tokens = card('Tokens (24 h)');
    expect(await within(tokens).findByText('18.4k')).toBeTruthy();
  });

  it('shows the token change against the previous 24 h, and says so when there is nothing to compare', async () => {
    await renderHome();
    expect(await screen.findByText('↓ 26% vs previous 24 h')).toBeTruthy();
  });

  it('does not invent a percentage without a previous window', async () => {
    await renderHome({ [`GET ${USAGE_24H}`]: usageFixture('24h', { previousTotalTokens: 0 }) });
    expect(await screen.findByText('no usage in the previous 24 h')).toBeTruthy();
    expect(screen.queryByText(/vs previous 24 h/)).toBeNull();
  });

  it('navigates from the KPI links to real pages', async () => {
    await renderHome();
    const links: [string, string][] = [
      ['Active projects', 'projects'], ['Running agents', 'monitor'], ['Queued tasks', 'monitor'],
      ['Open tasks', 'workflows'], ['Failed (24 h)', 'workflows'], ['Tokens (24 h)', 'models'],
    ];
    for (const [name, view] of links) {
      fireEvent.click(within(screen.getByRole('group', { name })).getByRole('button', { name: /^View .* →$/ }));
      expect(useStudio.getState().view).toBe(view);
      useStudio.setState({ view: 'home' });
    }
  });

  it('renders the six pipeline stages with their status, task, model and a brighter border for the running one', async () => {
    await renderHome();
    const stage = (name: string) => screen.getByRole('group', { name: `${name} stage` });

    const architect = stage('Architect');
    expect(within(architect).getByText('Done')).toBeTruthy();
    expect(within(architect).getByText('Write the technical plan')).toBeTruthy();
    expect(within(architect).getByText('claude-code · claude-saved')).toBeTruthy();
    expect(within(architect).getByText('2/2 · 2m 05s')).toBeTruthy();
    expect(within(architect).getByText('1 file changed')).toBeTruthy();

    const backend = stage('Backend');
    expect(within(backend).getByText('Running')).toBeTruthy();
    expect(within(backend).getByText('Implement search')).toBeTruthy();
    expect(backend.className).toContain('border-brand-violet');
    expect(architect.className).not.toContain('border-brand-violet');

    expect(within(stage('Frontend')).getByText('Pending')).toBeTruthy();
    const qa = stage('QA');
    expect(within(qa).getByText('Failed')).toBeTruthy();
    expect(within(qa).getByText('Tests failed: 3 failing')).toBeTruthy();
    expect(within(stage('Security')).getByText('Needs approval')).toBeTruthy();
    expect(within(stage('Review')).getByText('No tasks')).toBeTruthy();
    expect(screen.getAllByRole('group').filter((el) => el.getAttribute('aria-label')?.endsWith(' stage'))).toHaveLength(6);
  });

  it('opens the project board from the workflow panel', async () => {
    await renderHome();
    fireEvent.click(within(panel('Current Project Workflow')).getByRole('button', { name: 'Open project board →' }));
    expect(useStudio.getState().view).toBe('dashboard');
    expect(window.location.hash).toBe('#/board');
  });

  it('shows an empty workflow with Open Projects when there is no current project', async () => {
    useStudio.setState({ currentProjectId: null });
    installFetchMock(routes());
    render(<Home />);
    const workflow = (await screen.findByRole('heading', { name: 'Current Project Workflow' })).closest('.rounded-xl') as HTMLElement;
    expect(within(workflow).getByText('No project selected')).toBeTruthy();
    fireEvent.click(within(workflow).getByRole('button', { name: 'Open Projects' }));
    expect(useStudio.getState().view).toBe('projects');
  });

  it('lists all seven agents, with the disconnected one in amber and the reason', async () => {
    useStudio.setState({ providers: [provider({ id: 'gemini', label: 'Gemini', available: false, reason: 'CLI not installed' })] });
    await renderHome();
    expect(screen.getAllByLabelText(/ agent$/)).toHaveLength(7);

    const frontend = screen.getByLabelText('Frontend agent');
    const pill = within(frontend).getByText('Disconnected');
    expect(pill.className).toContain('text-st-waiting');
    expect(within(frontend).getByText('CLI not installed')).toBeTruthy();
    expect(within(frontend).getByText('—')).toBeTruthy();

    const backend = screen.getByLabelText('Backend agent');
    expect(within(backend).getByText('Running')).toBeTruthy();
    expect(within(backend).getByText('success 7 d: 83 %')).toBeTruthy();
    expect(within(backend).getByText('Implement search · Atlas')).toBeTruthy();
    expect(within(screen.getByLabelText('Architect agent')).getByText('success 7 d: 100 %')).toBeTruthy();
    expect(within(screen.getByLabelText('Reviewer agent')).getByText('No current task')).toBeTruthy();
  });

  it('lists the active projects with status and progress, and selecting one opens its board', async () => {
    const orion: ProjectSnapshot = {
      project: { id: 'project-2', name: 'Orion' } as ProjectSnapshot['project'], tasks: [], agents: [], approvals: [], recentEvents: [],
    };
    const network = await renderHome({ 'GET /api/projects/project-2': orion });
    const projects = panel('Active Projects');
    const row = within(projects).getByRole('button', { name: /Orion/ });
    expect(within(row).getByText('Paused')).toBeTruthy();
    expect(within(row).getByText('0/4 · 0%')).toBeTruthy();
    expect(within(projects).getByText('3/9 · 33%')).toBeTruthy();
    expect(within(projects).getByText('1 failed')).toBeTruthy();

    fireEvent.click(row);
    expect(useStudio.getState().currentProjectId).toBe('project-2');
    expect(useStudio.getState().view).toBe('dashboard');
    expect(window.location.hash).toBe('#/board');
    await waitFor(() => expect(network.calls).toContainEqual({ method: 'GET', path: '/api/projects/project-2', body: undefined }));
  });

  it('lists recent runs with result, project, time and duration', async () => {
    await renderHome();
    const runs = panel('Recent Runs');
    expect(within(runs).getByLabelText('Done')).toBeTruthy();
    expect(within(runs).getByLabelText('Failed')).toBeTruthy();
    expect(within(runs).getByText('Write the technical plan')).toBeTruthy();
    expect(within(runs).getByText('Atlas · 5m ago')).toBeTruthy();
    expect(within(runs).getByText('2m 05s')).toBeTruthy();
    expect(within(runs).getByText('Atlas · 10m ago')).toBeTruthy();
    expect(within(runs).getByText('9s')).toBeTruthy();
  });

  it('draws the model usage donut with a legend of tokens and shares, plus seven day bars', async () => {
    await renderHome();
    expect(await screen.findByRole('img', { name: 'Tokens by model, 18.4k in total' })).toBeTruthy();
    const legend = screen.getByRole('list', { name: 'Tokens by model' });
    const claude = within(legend).getByText('Claude Code · claude-saved').closest('li') as HTMLElement;
    expect(within(claude).getByText('12.0k')).toBeTruthy();
    expect(within(claude).getByText('65%')).toBeTruthy();
    const codex = within(legend).getByText('Codex · codex-default').closest('li') as HTMLElement;
    expect(within(codex).getByText('6.4k')).toBeTruthy();
    expect(within(codex).getByText('35%')).toBeTruthy();
    expect(within(panel('Model Usage (24 h)')).getByText(/8 model calls · reported cost \$0\.42/)).toBeTruthy();

    const bars = await screen.findByRole('img', { name: 'Tokens per day, last 7 days' });
    expect(within(bars).getAllByTitle(/tokens$/)).toHaveLength(7);
    expect(within(bars).getByTitle('2026-10-16: 18.4k tokens')).toBeTruthy();
  });

  it('omits the cost line when no provider reported a cost', async () => {
    await renderHome({ [`GET ${USAGE_24H}`]: usageFixture('24h', { costUsd: null }) });
    expect(await screen.findByText(/8 model calls/)).toBeTruthy();
    expect(screen.queryByText(/reported cost/)).toBeNull();
  });

  it('shows the project progress counts and bar', async () => {
    await renderHome();
    const progress = panel('Project Progress');
    const count = (label: string) => within(progress).getByText(label).previousElementSibling?.textContent;
    expect(count('Total')).toBe('9');
    expect(count('Completed')).toBe('3');
    expect(count('Running')).toBe('1');
    expect(count('Blocked')).toBe('1');
    expect(count('Failed')).toBe('1');
    expect(within(progress).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33');
  });

  it('offers only real quick-launch targets', async () => {
    await renderHome();
    const launch = panel('Quick launch');
    expect(within(launch).getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    fireEvent.click(within(launch).getByRole('button', { name: /Open Runs \(live monitor\)/ }));
    expect(useStudio.getState().view).toBe('monitor');
    fireEvent.click(within(launch).getByRole('button', { name: /Open Tasks/ }));
    expect(useStudio.getState().view).toBe('workflows');
    fireEvent.click(within(launch).getByRole('button', { name: /Models & Providers/ }));
    expect(useStudio.getState().view).toBe('models');
  });

  it('shows an onboarding empty state when there are no projects', async () => {
    useStudio.setState({ currentProjectId: null });
    const empty: OverviewResponse = overviewFixture({
      currentProject: null, activeProjects: [], recentRuns: [],
      projects: { total: 0, active: 0, createdLast7d: 0 },
    });
    installFetchMock(routes({ 'GET /api/v2/overview': empty }));
    render(<Home />);
    expect(await screen.findByText('Start with your first project')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Active projects' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try the sample' }));
    expect(useStudio.getState().view).toBe('projects');
    useStudio.setState({ view: 'home' });
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(useStudio.getState().view).toBe('projects');
  });

  it('shows an error with Retry when the overview fails, and recovers on retry', async () => {
    let attempts = 0;
    installFetchMock(routes({
      [`GET ${OVERVIEW}`]: () => (++attempts === 1 ? { status: 500, json: { error: 'database is locked' } } : { json: overviewFixture() }),
    }));
    render(<Home />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Could not load the overview')).toBeTruthy();
    expect(within(alert).getByText('database is locked')).toBeTruthy();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Current Project Workflow' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(attempts).toBe(2);
  });

  it('keeps the rest of the page usable when only the usage request fails', async () => {
    await renderHome({ [`GET ${USAGE_24H}`]: () => ({ status: 500, json: { error: 'usage offline' } }) });
    expect(await screen.findByText('Usage unavailable', { selector: 'p' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Tokens (24 h)' })).getByText('—')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Agent Health' })).toBeTruthy();
  });
});
