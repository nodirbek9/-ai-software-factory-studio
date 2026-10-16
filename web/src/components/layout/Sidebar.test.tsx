import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/app/navigation';
import { useStudio } from '@/store/studio';
import { provider } from '@/test/fixtures';
import { Sidebar } from './Sidebar';

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
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

  it('navigates with live items and explains planned ones instead of navigating', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(useStudio.getState().view).toBe('logs');
    expect(window.location.hash).toBe('#/logs');

    const workspace = screen.getByRole('button', { name: 'Agent Workspace' });
    expect(workspace.getAttribute('aria-disabled')).toBe('true');
    expect(workspace.getAttribute('title')).toMatch(/Phase 3/);
    fireEvent.click(workspace);
    expect(useStudio.getState().view).toBe('logs');
    for (const item of NAV_ITEMS.filter((entry) => entry.view === null)) {
      expect(screen.getByText(item.plannedReason!)).toBeTruthy();
    }
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

  it('collapses and expands', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useStudio.getState().leftCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });
});
