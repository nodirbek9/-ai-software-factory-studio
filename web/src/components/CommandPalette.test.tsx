import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Project, ProjectSnapshot, ProjectStatus } from '@asf/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { NAV_ITEMS } from '@/app/navigation';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';

const project = (id: string, name: string, status: ProjectStatus = 'draft') => ({ id, name, status }) as unknown as Project;
const snapshotOf = (item: Project): ProjectSnapshot => ({ project: item, tasks: [], agents: [], approvals: [], recentEvents: [] });

function openPalette() {
  const onClose = vi.fn();
  render(<CommandPalette open onClose={onClose} />);
  return { onClose, input: screen.getByRole('combobox', { name: 'Search commands' }) };
}

/** A store with two projects where the first is current and has the given status. */
function seedProjects(status: ProjectStatus) {
  const atlas = project('p1', 'Atlas', status);
  useStudio.setState({ projects: [atlas, project('p2', 'Orion')], currentProjectId: 'p1', snapshot: snapshotOf(atlas) });
  return atlas;
}

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
});

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    render(<CommandPalette open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is an accessible dialog listing every navigation item', () => {
    openPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(NAV_ITEMS.length);
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
  });

  it('filters by text and Enter navigates then closes', () => {
    const { input, onClose } = openPalette();
    fireEvent.change(input, { target: { value: 'log' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Logs');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/logs');
    expect(useStudio.getState().view).toBe('logs');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a message when nothing matches', () => {
    const { input } = openPalette();
    fireEvent.change(input, { target: { value: 'zzzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching commands')).toBeTruthy();
  });

  it('moves the active option with the arrow keys', () => {
    const { input } = openPalette();
    const selected = () => screen.getAllByRole('option').findIndex((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(selected()).toBe(0);
  });

  it('lists a planned item with its reason and does not navigate or close on Enter', () => {
    const { input, onClose } = openPalette();
    const planned = NAV_ITEMS.find((item) => item.label === 'QA & Security');
    expect(planned?.plannedReason).toBeTruthy();
    fireEvent.change(input, { target: { value: 'QA & Security' } });
    const option = screen.getByRole('option', { name: /QA & Security/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(planned!.plannedReason!)).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(option);
    expect(window.location.hash).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens the Agent Workspace page from the palette', () => {
    const { input, onClose } = openPalette();
    fireEvent.change(input, { target: { value: 'Agent Workspace' } });
    const option = screen.getByRole('option', { name: /Agent Workspace/ });
    expect(option.getAttribute('aria-disabled')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useStudio.getState().view).toBe('workspace');
    expect(window.location.hash).toBe('#/workspace');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on a click on the overlay', () => {
    const { input, onClose } = openPalette();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('switches project and opens the Project board', async () => {
    const orion = project('p2', 'Orion');
    seedProjects('draft');
    const network = installFetchMock({ 'GET /api/projects/p2': snapshotOf(orion) });
    const { input, onClose } = openPalette();
    expect(screen.getByRole('option', { name: /Switch to Atlas.*Current/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'orion' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useStudio.getState().currentProjectId).toBe('p2');
    expect(useStudio.getState().view).toBe('dashboard');
    expect(window.location.hash).toBe('#/board');
    await waitFor(() => expect(useStudio.getState().snapshot?.project.id).toBe('p2'));
    expect(network.calls).toContainEqual({ method: 'GET', path: '/api/projects/p2', body: undefined });
  });

  it('offers Pause only for a running project and posts to the pause route', async () => {
    const atlas = seedProjects('running');
    const network = installFetchMock({ 'POST /api/projects/p1/pause': {}, 'GET /api/projects/p1': snapshotOf(atlas) });
    const { input, onClose } = openPalette();
    expect(screen.queryByRole('option', { name: /Generate plan/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Resume project/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Stop project/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'pause' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(network.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/projects/p1/pause' })));
  });

  it('offers Generate plan, not Pause, for a draft project', () => {
    seedProjects('draft');
    openPalette();
    expect(screen.getByRole('option', { name: /Generate plan/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Pause project/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Stop project/ })).toBeNull();
  });

  it('offers Resume for a paused project', () => {
    seedProjects('paused');
    openPalette();
    expect(screen.getByRole('option', { name: /Resume project/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Pause project/ })).toBeNull();
  });

  it('does not stop the project when the confirmation is declined', () => {
    seedProjects('running');
    const network = installFetchMock({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { input } = openPalette();
    fireEvent.change(input, { target: { value: 'stop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(confirm).toHaveBeenCalledWith('Stop this project? Running tasks are cancelled; completed work stays on the integration branch.');
    expect(network.calls).toEqual([]);
  });
});
