import { act, render, screen, within } from '@testing-library/react';
import { AGENT_ROLE_INFO } from '@asf/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Monitor } from './Monitor';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { liveSnapshot } from '@/test/fixtures';

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
});

describe('Monitor', () => {
  it('shows loading until a live snapshot is available', () => {
    installFetchMock({});
    render(<Monitor />);
    expect(screen.getByText('Loading live state…')).toBeTruthy();
  });

  it('fetches live state and displays running agents, queue, provider usage and finished tasks', async () => {
    const live = liveSnapshot();
    const network = installFetchMock({ 'GET /api/live': live });
    await act(() => useStudio.getState().refreshLive());
    render(<Monitor />);

    expect(network.calls).toEqual([{ method: 'GET', path: '/api/live', body: undefined }]);
    for (const agent of live.running) {
      const card = screen.getByRole('button', { name: new RegExp(agent.taskTitle) });
      const queries = within(card);
      expect(queries.getByText(AGENT_ROLE_INFO[agent.role].name)).toBeTruthy();
      expect(queries.getByText(`in ${agent.projectName}`)).toBeTruthy();
      expect(queries.getByText(agent.taskTitle)).toBeTruthy();
      expect(queries.getByText(agent.providerLabel!)).toBeTruthy();
      expect(queries.getByText(agent.model!)).toBeTruthy();
      expect(queries.getByText('attempt 1 of 3')).toBeTruthy();
    }
    for (const text of ['high effort', 'default effort', 'fallback from claude-code',
      'needs your approval', 'next in line', 'Approve plan', 'Build index', '1 working']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    const stat = screen.getByText('Agents working').parentElement!;
    expect(within(stat).getByText(`2 of ${live.maxParallel}`)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Queue (2)' })).toBeTruthy();
    expect(screen.getAllByText('2 calls, 120 tok')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Recently finished' })).toBeTruthy();
    const row = screen.getByRole('row', { name: /Gather requirements/ });
    expect(within(row).getByText('done')).toBeTruthy();
  });

  it('shows an empty state when no agents are running', () => {
    installFetchMock({});
    useStudio.setState({ live: { ...liveSnapshot(), running: [], queued: [], recent: [] } });
    render(<Monitor />);
    expect(screen.getByText('No agent is working right now')).toBeTruthy();
    expect(screen.getByText('Nothing is waiting to start.')).toBeTruthy();
    expect(screen.getByText('No finished tasks yet.')).toBeTruthy();
  });
});
