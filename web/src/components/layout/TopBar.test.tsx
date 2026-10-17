import { act, fireEvent, render, screen } from '@testing-library/react';
import type { StudioEvent } from '@asf/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '@/store/studio';
import { TopBar } from './TopBar';

const alert = (id: number, projectId = 'p1'): StudioEvent => ({
  id, projectId, taskId: null, role: null, type: 'task.failed', level: 'error', message: `Task ${id} failed`, data: null, createdAt: '2026-10-16T10:00:00Z',
});

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
});

describe('TopBar notifications', () => {
  it('shows no dot when nothing needs attention', () => {
    render(<TopBar onOpenPalette={() => {}} />);
    expect(screen.queryByTestId('notification-dot')).toBeNull();
  });

  it('shows the dot for unseen alerts, clears it once the dropdown was opened and remembers the highest id', () => {
    useStudio.setState({ currentProjectId: 'p1', events: [alert(3), alert(7)] });
    render(<TopBar onOpenPalette={() => {}} />);
    expect(screen.getByTestId('notification-dot')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Task 7 failed')).toBeTruthy();
    expect(screen.queryByTestId('notification-dot')).toBeNull();
    expect(localStorage.getItem('asf.notifications.seen')).toBe('7');

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.queryByTestId('notification-dot')).toBeNull();
  });

  it('starts without a dot when every alert was seen before, and shows it again for a newer one', () => {
    localStorage.setItem('asf.notifications.seen', '7');
    useStudio.setState({ currentProjectId: 'p1', events: [alert(3), alert(7)] });
    render(<TopBar onOpenPalette={() => {}} />);
    expect(screen.queryByTestId('notification-dot')).toBeNull();

    act(() => useStudio.setState({ events: [alert(3), alert(7), alert(9)] }));
    expect(screen.getByTestId('notification-dot')).toBeTruthy();
  });
});
