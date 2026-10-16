import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/app/navigation';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { healthFixture, provider } from '@/test/fixtures';
import { Sidebar } from './Sidebar';

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  // Without a health route the request fails, which exercises the connection-based fallback rows.
  installFetchMock({});
});

describe('Sidebar', () => {
  it('lists the 11 V2 destinations and marks the current page', () => {
    useStudio.setState({ view: 'monitor' });
    render(<Sidebar />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.querySelectorAll('button')).toHaveLength(11);
    expect(screen.getByRole('button', { name: 'Runs' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('navigates with live items; every item is live since Phase 6', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(useStudio.getState().view).toBe('logs');
    expect(window.location.hash).toBe('#/logs');

    const quality = screen.getByRole('button', { name: 'QA & Security' });
    expect(quality.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(quality);
    expect(useStudio.getState().view).toBe('quality');
    expect(window.location.hash).toBe('#/quality');
    expect(NAV_ITEMS.filter((entry) => entry.view === null)).toEqual([]);
  });

  it('opens the Workflow Builder page', () => {
    render(<Sidebar />);
    const builder = screen.getByRole('button', { name: 'Workflow Builder' });
    expect(builder.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(builder);
    expect(useStudio.getState().view).toBe('builder');
    expect(window.location.hash).toBe('#/builder');
    expect(builder.getAttribute('aria-current')).toBe('page');
  });

  it('opens the Agent Workspace page', () => {
    render(<Sidebar />);
    const workspace = screen.getByRole('button', { name: 'Agent Workspace' });
    expect(workspace.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(workspace);
    expect(useStudio.getState().view).toBe('workspace');
    expect(window.location.hash).toBe('#/workspace');
    expect(workspace.getAttribute('aria-current')).toBe('page');
  });

  it('highlights Models & Providers for the V1 Providers and Agents views', () => {
    useStudio.setState({ view: 'agents' });
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Models & Providers' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows real system status from the connection and the providers', () => {
    useStudio.setState({
      connection: 'live',
      providers: [provider(), provider({ id: 'codex', label: 'Codex', available: false, reason: 'not installed' })],
    });
    render(<Sidebar />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('1 of 2 usable')).toBeTruthy();
    expect(screen.getByText('Partly degraded')).toBeTruthy();
  });

  it('shows the server health checks once /api/v2/system/health loads', async () => {
    const network = installFetchMock({ 'GET /api/v2/system/health': healthFixture() });
    useStudio.setState({ connection: 'live', providers: [provider()] });
    render(<Sidebar />);
    expect(screen.getByText('Connected')).toBeTruthy();
    const status = screen.getByRole('region', { name: 'System status' });
    expect(await within(status).findByText('Schema v7')).toBeTruthy();
    for (const text of ['Database', 'Event stream', 'Git', '1 of 2 available', '120 GB free', 'Partly degraded']) {
      expect(within(status).getByText(text)).toBeTruthy();
    }
    expect(within(status).queryByText('Connected')).toBeNull();
    expect(network.calls).toContainEqual({ method: 'GET', path: '/api/v2/system/health', body: undefined });
  });

  it('opens Home from the Home item and keeps it highlighted on the Project board', () => {
    useStudio.setState({ view: 'dashboard' });
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(useStudio.getState().view).toBe('home');
    expect(window.location.hash).toBe('#/home');
  });

  it('collapses and expands', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useStudio.getState().leftCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });
});
