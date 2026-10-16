import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { Settings } from './Settings';
import { useStudio } from '@/store/studio';
import { installFetchMock } from '@/test/fetchMock';
import { fsRoots, provider, providers, serverInfo } from '@/test/fixtures';

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  useStudio.setState({
    info: { ...serverInfo, settings: { ...serverInfo.settings, fallbackOrder: [...serverInfo.settings.fallbackOrder] } },
    providers: [...providers, provider({ id: 'gemini', label: 'Gemini' })],
  });
});

function mockSettings() {
  return installFetchMock({
    'GET /api/fs/roots': fsRoots,
    'PUT /api/settings': (body: unknown) => ({ json: body }),
  });
}

async function renderSettings() {
  render(<Settings />);
  await screen.findByText('No approved folders yet.');
}

describe('Settings', () => {
  it('shows the unavailable state without server information', () => {
    mockSettings();
    useStudio.setState({ info: null });
    render(<Settings />);
    expect(screen.getByText('Server information is unavailable')).toBeTruthy();
  });

  it('appends unchecked providers, reorders them and saves only checked providers in visible order', async () => {
    const network = mockSettings();
    await renderSettings();
    const list = screen.getByRole('list', { name: 'Fallback order' });
    const labels = () => within(list).getAllByRole('checkbox').map((input) => input.parentElement!.textContent);
    expect(labels()).toEqual(['Claude Code', 'Codex', 'Gemini']);
    const checkbox = (name: string) => within(list).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(checkbox('Claude Code').checked).toBe(true);
    expect(checkbox('Codex').checked).toBe(true);
    expect(checkbox('Gemini').checked).toBe(false);
    expect((screen.getByRole('button', { name: 'Move Claude Code up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Gemini down' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(checkbox('Codex'));
    fireEvent.click(checkbox('Gemini'));
    fireEvent.click(screen.getByRole('button', { name: 'Move Gemini up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Claude Code down' }));
    expect(labels()).toEqual(['Gemini', 'Claude Code', 'Codex']);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(network.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/settings', body: { ...serverInfo.settings, fallbackOrder: ['gemini', 'claude-code'] } },
    ]);
    expect(network.calls[0]).toEqual({ method: 'GET', path: '/api/fs/roots', body: undefined });
  });

  it.each([3, 0])('saves fix rounds of %i, including the zero boundary', async (value) => {
    const network = mockSettings();
    await renderSettings();
    const input = screen.getByLabelText(/^Fix rounds per check/) as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe(String(serverInfo.settings.maxFixRounds));
    fireEvent.change(input, { target: { value: String(value) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(network.calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/settings', body: { ...serverInfo.settings, maxFixRounds: value } },
    ]);
  });

  it('rejects fix rounds above five with an alert and no settings request', async () => {
    const network = mockSettings();
    await renderSettings();
    fireEvent.change(screen.getByLabelText(/^Fix rounds per check/), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('Fix rounds per check must be a whole number from 0 to 5.');
    expect(network.calls.filter((call) => call.method === 'PUT')).toEqual([]);
  });
});
