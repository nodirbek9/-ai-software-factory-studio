import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { UsageDailyRow } from '@asf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Models } from '@/pages/Models';
import { Providers, limitLabel, resumeLabel } from '@/pages/Providers';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { provider, providers, serverInfo, settings } from '@/test/fixtures';
import { projectFixture } from '@/test/sessionFixtures';
import { UsageTab, formatUsageCost, groupUsage, totalUsage } from './UsageTab';
import * as usageApi from './usageApi';

vi.mock('./usageApi');
const mocked = vi.mocked(usageApi);

function usageRow(overrides: Partial<UsageDailyRow>): UsageDailyRow {
  return {
    day: '2026-10-16', providerId: 'claude-code', model: 'opus', projectId: 'project-1', projectName: 'Atlas',
    inputTokens: 1000, outputTokens: 500, costUsd: 0.5, calls: 2, ...overrides,
  };
}

const ROWS: UsageDailyRow[] = [
  usageRow({}),
  usageRow({ providerId: 'codex', model: 'gpt', inputTokens: 2000, outputTokens: 1000, costUsd: null, calls: 3 }),
  usageRow({ day: '2026-10-15', providerId: 'codex', model: null, projectId: null, projectName: null, inputTokens: 4000, outputTokens: 1000, costUsd: null, calls: 1 }),
];

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const lastCall = () => mocked.getUsageDaily.mock.lastCall;

async function openUsage(rows: UsageDailyRow[] = ROWS) {
  mocked.getUsageDaily.mockResolvedValue({ days: 30, rows });
  render(<UsageTab />);
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading usage' })).toBeNull());
}

beforeEach(() => {
  vi.resetAllMocks();
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({
    providers, info: { ...serverInfo, settings: { ...settings } },
    projects: [projectFixture()], currentProjectId: 'project-1',
  });
});

describe('usage grouping', () => {
  it('folds rows per day and keeps unknown cost null instead of 0', () => {
    const days = groupUsage(ROWS, 'day');
    expect(days.map((row) => row.key)).toEqual(['2026-10-16', '2026-10-15']);
    expect(days[0]).toMatchObject({ inputTokens: 3000, outputTokens: 1500, costUsd: 0.5, calls: 5 });
    expect(days[1].costUsd).toBeNull();
    expect(formatUsageCost(null)).toBe('—');
    expect(formatUsageCost(0)).toBe('$0.00');
  });

  it('groups by provider, model and project', () => {
    expect(groupUsage(ROWS, 'provider').map((row) => [row.key, row.costUsd])).toEqual([['codex', null], ['claude-code', 0.5]]);
    expect(groupUsage(ROWS, 'model').map((row) => row.label).sort()).toEqual(['Default', 'gpt', 'opus']);
    expect(groupUsage(ROWS, 'project').map((row) => row.label)).toEqual(['No project', 'Atlas']);
  });

  it('totals the groups and flags a partial cost', () => {
    expect(totalUsage(groupUsage(ROWS, 'day'))).toEqual({ inputTokens: 7000, outputTokens: 2500, costUsd: 0.5, calls: 6, partialCost: true });
    expect(totalUsage(groupUsage([ROWS[1]], 'day')).costUsd).toBeNull();
  });
});

describe('Usage tab', () => {
  it('loads 30 days for all projects and renders rows with totals and "—" for unknown cost', async () => {
    await openUsage();
    expect(lastCall()).toEqual([30, undefined]);
    expect(within(rowOf('2026-10-16')).getByText('$0.50')).toBeTruthy();
    expect(within(rowOf('2026-10-15')).getByText('—')).toBeTruthy();
    const totals = screen.getByTestId('usage-totals');
    expect(within(totals).getByText('7.0k')).toBeTruthy();
    expect(within(totals).getByText('2.5k')).toBeTruthy();
    expect(within(totals).getByText('$0.50+')).toBeTruthy();
    expect(within(totals).getByText('6')).toBeTruthy();
    expect(screen.getAllByTestId('usage-bar')).toHaveLength(2);
    expect(screen.getByText(/Costs only when the provider reports them \(D-011\)/)).toBeTruthy();
  });

  it('switches the grouping', async () => {
    await openUsage();
    fireEvent.click(screen.getByRole('radio', { name: 'Provider' }));
    expect(within(rowOf('Codex')).getByText('—')).toBeTruthy();
    expect(within(rowOf('Claude Code')).getByText('$0.50')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Model' }));
    expect(screen.getByText('Default')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Project' }));
    const table = within(screen.getByRole('table'));
    expect(table.getByText('No project')).toBeTruthy();
    expect(table.getByText('Atlas')).toBeTruthy();
    expect(mocked.getUsageDaily).toHaveBeenCalledTimes(1);
  });

  it('reloads for another range and for the header project', async () => {
    await openUsage();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(lastCall()).toEqual([7, undefined]));
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'current' } });
    await waitFor(() => expect(lastCall()).toEqual([7, 'project-1']));
  });

  it('disables the project filter option when no project is selected', async () => {
    useStudio.setState({ currentProjectId: null });
    await openUsage();
    expect((screen.getByRole('option', { name: /Current project/ }) as HTMLOptionElement).disabled).toBe(true);
  });

  it('shows an empty state', async () => {
    await openUsage([]);
    expect(screen.getByText('No usage recorded')).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    mocked.getUsageDaily.mockRejectedValueOnce(new Error('usage failed'));
    render(<UsageTab />);
    expect(await screen.findByText('usage failed')).toBeTruthy();
    mocked.getUsageDaily.mockResolvedValue({ days: 30, rows: ROWS });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2026-10-16')).toBeTruthy();
  });
});

describe('Models tabs', () => {
  it('lists Providers, Agents, Usage and Fallback order', async () => {
    installFetchMock({ 'GET /api/usage': [] });
    mocked.getUsageDaily.mockResolvedValue({ days: 30, rows: [] });
    render(<Models />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Providers', 'Agents', 'Usage', 'Fallback order']);
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
    expect(screen.getByRole('tab', { name: 'Usage' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('No usage recorded')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Fallback order' }));
    expect(screen.getByRole('list', { name: 'Fallback order' })).toBeTruthy();
  });
});

describe('Fallback tab', () => {
  function openFallback() {
    installFetchMock({});
    render(<Models />);
    fireEvent.click(screen.getByRole('tab', { name: 'Fallback order' }));
  }

  it('lists the settings order with availability and links to Settings', () => {
    useStudio.setState({
      info: { ...serverInfo, settings: { ...settings, fallbackOrder: ['codex', 'claude-code', 'gone'] } },
      providers: [provider({ id: 'claude-code', label: 'Claude Code', enabled: false }), provider({ id: 'codex', label: 'Codex' }),
        provider({ id: 'gemini', label: 'Gemini' })],
    });
    openFallback();
    const items = within(screen.getByRole('list', { name: 'Fallback order' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['1CodexAvailable', '2Claude CodeDisabled', '3goneNot registered on this server']);
    expect(screen.getByText(/Not used for fallback: Gemini/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Settings' }));
    expect(useStudio.getState().view).toBe('settings');
  });

  it('shows an empty state when fallback is off', () => {
    useStudio.setState({ info: { ...serverInfo, settings: { ...settings, fallbackOrder: [] } } });
    openFallback();
    expect(screen.getByText('No fallback providers')).toBeTruthy();
  });
});

describe('Provider labels', () => {
  const cardOf = (name: string) => screen.getByRole('heading', { name }).parentElement?.parentElement as HTMLElement;

  it('labels CLI login, API key and built-in providers with resume and limit state', () => {
    const limitedUntil = new Date(2026, 9, 17, 14, 5).toISOString();
    useStudio.setState({
      providers: [
        provider({ id: 'claude-code', label: 'Claude Code CLI', kind: 'cli', limitedUntil }),
        provider({ id: 'codex', label: 'Codex CLI', kind: 'cli' }),
        provider({ id: 'openai-compatible', label: 'OpenAI-compatible', kind: 'api' }),
        provider({ id: 'scripted', label: 'Scripted', kind: 'builtin', isAi: false }),
      ],
    });
    installFetchMock({ 'GET /api/usage': [] });
    render(<Providers />);
    const claude = within(cardOf('Claude Code CLI'));
    expect(claude.getByText('CLI login')).toBeTruthy();
    expect(claude.getByText('Limit until 14:05')).toBeTruthy();
    expect(claude.getByText(/Native resume/)).toBeTruthy();
    expect(within(cardOf('Codex CLI')).getByText(/Native resume/)).toBeTruthy();
    expect(within(cardOf('Codex CLI')).queryByText(/Limit until/)).toBeNull();
    const api = within(cardOf('OpenAI-compatible'));
    expect(api.getByText('API key')).toBeTruthy();
    expect(api.getByText(/Context replay/)).toBeTruthy();
    expect(within(cardOf('Scripted')).getByText('Built-in')).toBeTruthy();
  });

  it('maps resume support and ignores an invalid limit time', () => {
    expect(['claude-code', 'claude-code-4', 'codex'].map(resumeLabel)).toEqual(['Native resume', 'Native resume', 'Native resume']);
    expect(['gemini', 'antigravity', 'openai-compatible', 'scripted'].map(resumeLabel)).toEqual(Array(4).fill('Context replay'));
    expect(limitLabel({ limitedUntil: null })).toBeNull();
    expect(limitLabel({ limitedUntil: 'not a date' })).toBeNull();
  });
});
